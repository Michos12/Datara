import {
  recommendationRulesSchema,
  type Priority,
  type Recommendation,
  type RecommendationCustomer,
  type RecommendationCustomersPage,
  type RecommendationCustomersQuery,
  type RecommendationList,
  type RecommendationListQuery,
  type RecommendationRule,
  type RecommendationRules,
  type RecommendationStatus,
  type UpdateRecommendationRequest,
} from '@ci/contracts';
import { AppError } from '../../core/errors.js';
import type { AuthContext } from '../../core/request-context.js';
import type { AnalyticsClient } from '../../infra/analytics-client.js';
import { toNumber, type Database, type Tx } from '../../infra/database.js';
import { recordAudit } from '../audit/audit.service.js';
import { latestRunId } from '../analytics/query-cache.js';

type DbStatus = 'OPEN' | 'ACKNOWLEDGED' | 'DONE' | 'DISMISSED' | 'EXPIRED';
type DbPriority = 'HIGH' | 'MEDIUM' | 'LOW';

const REVENUE_BASIS =
  "affected customers' net revenue in the 12 months before the analytics run (measured)";

interface RecommendationRow {
  id: string;
  ruleKey: string;
  ruleVersion: number;
  priority: DbPriority;
  priorityScore: { toNumber(): number } | number;
  status: DbStatus;
  title: string;
  opportunity: string;
  explanation: string;
  suggestedAction: string;
  metrics: unknown;
  affectedCustomers: number;
  revenueAtStakeCents: bigint | null;
  dismissReason: string | null;
  statusChangedAt: Date | null;
  firstDetectedAt: Date;
  lastDetectedAt: Date;
}

export function toRecommendation(row: RecommendationRow): Recommendation {
  return {
    id: row.id,
    ruleKey: row.ruleKey as RecommendationRule,
    ruleVersion: row.ruleVersion,
    priority: row.priority.toLowerCase() as Priority,
    priorityScore:
      typeof row.priorityScore === 'number' ? row.priorityScore : row.priorityScore.toNumber(),
    status: row.status.toLowerCase() as RecommendationStatus,
    title: row.title,
    opportunity: row.opportunity,
    explanation: row.explanation,
    suggestedAction: row.suggestedAction,
    metrics:
      row.metrics && typeof row.metrics === 'object' && !Array.isArray(row.metrics)
        ? (row.metrics as Record<string, unknown>)
        : {},
    affectedCustomers: row.affectedCustomers,
    revenueAtStakeCents:
      row.revenueAtStakeCents === null ? null : toNumber(row.revenueAtStakeCents),
    revenueAtStakeBasis: REVENUE_BASIS,
    dismissReason: row.dismissReason,
    statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
    firstDetectedAt: row.firstDetectedAt.toISOString(),
    lastDetectedAt: row.lastDetectedAt.toISOString(),
  };
}

interface CustomerRow {
  customer_id: string;
  external_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  value_cents: bigint;
  segment_key: string | null;
  last_order_date: Date | null;
}

const toCustomer = (row: CustomerRow): RecommendationCustomer => ({
  customerId: row.customer_id,
  externalId: row.external_id,
  firstName: row.first_name,
  lastName: row.last_name,
  email: row.email,
  valueCents: toNumber(row.value_cents),
  segment: row.segment_key,
  lastOrderDate: row.last_order_date ? row.last_order_date.toISOString().slice(0, 10) : null,
});

/**
 * Recommendations (REC-01 … 05). The analytics worker writes them after each snapshot; this
 * module lists them, records status changes and serves the affected customers.
 */
export class RecommendationService {
  constructor(
    private readonly db: Database,
    private readonly client: AnalyticsClient,
    private readonly now: () => number = Date.now,
  ) {}

  async list(auth: AuthContext, query: RecommendationListQuery): Promise<RecommendationList> {
    const rows = await this.db.run(auth, (tx) =>
      tx.recommendation.findMany({
        where: {
          organizationId: auth.organizationId,
          status: { in: query.status.map((s) => s.toUpperCase() as DbStatus) },
          ...(query.priority
            ? { priority: { in: query.priority.map((p) => p.toUpperCase() as DbPriority) } }
            : {}),
          ...(query.ruleKey ? { ruleKey: query.ruleKey } : {}),
        },
        orderBy: [{ priorityScore: 'desc' }, { lastDetectedAt: 'desc' }, { id: 'asc' }],
        take: query.limit,
      }),
    );
    return { data: rows.map(toRecommendation) };
  }

  async get(auth: AuthContext, id: string): Promise<Recommendation> {
    const row = await this.db.run(auth, (tx) => this.find(tx, auth.organizationId, id));
    return toRecommendation(row);
  }

  async update(
    auth: AuthContext,
    id: string,
    input: UpdateRecommendationRequest,
    ip: string | null,
  ): Promise<Recommendation> {
    return this.db.run(auth, async (tx) => {
      const current = await this.find(tx, auth.organizationId, id);
      if (current.status === 'EXPIRED') {
        throw new AppError('CONFLICT', 'This recommendation has expired: its condition is gone');
      }
      const status = input.status.toUpperCase() as DbStatus;
      const row = await tx.recommendation.update({
        where: { id },
        data: {
          status,
          dismissReason: input.status === 'dismissed' ? input.dismissReason! : null,
          // Revenue at stake when closed: it must grow by 50% to reopen early (REC-04).
          statusRevenueCents: current.revenueAtStakeCents,
          statusChangedById: auth.userId ?? null,
          statusChangedAt: new Date(this.now()),
        },
      });
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'recommendation.status',
        entityType: 'recommendation',
        entityId: id,
        details: { from: current.status.toLowerCase(), to: input.status, rule: current.ruleKey },
        ip,
      });
      return toRecommendation(row);
    });
  }

  async customers(
    auth: AuthContext,
    id: string,
    query: RecommendationCustomersQuery,
  ): Promise<RecommendationCustomersPage> {
    const offset = query.cursor ? Number(query.cursor) : 0;
    const { rows, total } = await this.db.run(auth, async (tx) => {
      await this.find(tx, auth.organizationId, id);
      const total = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM recommendation_customers rc
        JOIN customers c ON c.id = rc.customer_id AND c.deleted_at IS NULL
        WHERE rc.recommendation_id = ${id}::uuid`;
      return {
        rows: await this.page(tx, auth.organizationId, id, query.limit, offset),
        total: Number(total[0]?.n ?? 0),
      };
    });
    const next = offset + query.limit;
    return {
      data: rows.map(toCustomer),
      page: { nextCursor: next < total ? String(next) : null, limit: query.limit, total },
    };
  }

  /** Every affected customer, for the CSV export (audited by the caller). */
  async *allCustomers(auth: AuthContext, id: string): AsyncGenerator<RecommendationCustomer> {
    await this.get(auth, id);
    for (let offset = 0; ; offset += 1000) {
      const rows = await this.db.run(auth, (tx) =>
        this.page(tx, auth.organizationId, id, 1000, offset),
      );
      for (const row of rows) yield toCustomer(row);
      if (rows.length < 1000) return;
    }
  }

  async rules(): Promise<RecommendationRules> {
    return recommendationRulesSchema.parse(await this.client.recommendationRules());
  }

  private async find(tx: Tx, organizationId: string, id: string) {
    const row = await tx.recommendation.findFirst({ where: { id, organizationId } });
    if (!row) throw new AppError('NOT_FOUND', 'Recommendation not found');
    return row;
  }

  private async page(
    tx: Tx,
    organizationId: string,
    id: string,
    limit: number,
    offset: number,
  ): Promise<CustomerRow[]> {
    const run = await latestRunId(tx, organizationId);
    return tx.$queryRaw<CustomerRow[]>`
      SELECT rc.customer_id::text AS customer_id, c.external_id, c.first_name, c.last_name,
             c.email::text AS email, rc.value_cents, m.segment_key, m.last_order_date
      FROM recommendation_customers rc
      JOIN customers c ON c.id = rc.customer_id AND c.deleted_at IS NULL
      LEFT JOIN analytics_customer_metrics m ON m.customer_id = rc.customer_id
        AND m.run_id = ${run}::uuid
      WHERE rc.recommendation_id = ${id}::uuid
      ORDER BY rc.value_cents DESC, rc.customer_id
      LIMIT ${limit} OFFSET ${offset}`;
  }
}
