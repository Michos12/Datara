import {
  DEFAULT_SEGMENT_CONFIG,
  NO_PURCHASES_SEGMENT,
  segmentConfigSchema,
  segmentPreviewResponseSchema,
  type SegmentConfig,
  type SegmentConfigVersion,
  type SegmentPreviewResponse,
  type SegmentsResponse,
} from '@ci/contracts';
import { AppError } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import type { AuthContext } from '../../core/request-context.js';
import type { AnalyticsClient } from '../../infra/analytics-client.js';
import { toNumber, type Database, type Tx } from '../../infra/database.js';
import { scheduleRecompute } from '../../infra/job-queue.js';
import { recordAudit } from '../audit/audit.service.js';

interface ConfigRow {
  id: string;
  version: number;
  config: unknown;
  isActive: boolean;
  createdAt: Date;
}

function toVersion(row: ConfigRow): SegmentConfigVersion {
  return {
    id: row.id,
    version: row.version,
    isActive: row.isActive,
    // Stored configs were validated on save; parse again so the API never serves a bad shape.
    config: segmentConfigSchema.parse(row.config),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Creates version 1 with the default configuration (signup, or first access for old orgs). */
export async function seedSegmentConfig(tx: Tx, organizationId: string, userId: string | null) {
  return tx.segmentConfig.create({
    data: {
      id: newId(),
      organizationId,
      version: 1,
      config: DEFAULT_SEGMENT_CONFIG as object,
      isActive: true,
      createdById: userId,
    },
  });
}

interface SummaryRow {
  segment_key: string | null;
  customers: number;
  revenue: bigint | null;
  avg_recency: number | null;
  avg_orders: number | null;
  avg_spend: number | null;
  avg_clv: number | null;
}

/** Per-run segment aggregates: snapshots are immutable, so entries never go stale. */
const SNAPSHOT_AGGREGATES = new Map<
  string,
  [SummaryRow[], { r: number; f: number; n: number }[]]
>();

export class SegmentService {
  constructor(
    private readonly db: Database,
    private readonly client: AnalyticsClient,
  ) {}

  async activeConfig(auth: AuthContext): Promise<SegmentConfigVersion> {
    return this.db.run(auth, async (tx) => toVersion(await this.ensureActive(tx, auth)));
  }

  async versions(auth: AuthContext): Promise<SegmentConfigVersion[]> {
    return this.db.run(auth, async (tx) => {
      await this.ensureActive(tx, auth);
      const rows = await tx.segmentConfig.findMany({
        where: { organizationId: auth.organizationId },
        orderBy: { version: 'desc' },
        take: 50,
      });
      return rows.map(toVersion);
    });
  }

  /** Saves a new version; activating it schedules an immediate recompute. */
  async save(
    auth: AuthContext,
    config: SegmentConfig,
    activate: boolean,
    ip: string | null,
  ): Promise<SegmentConfigVersion> {
    return this.db.run(auth, async (tx) => {
      await this.ensureActive(tx, auth);
      const latest = await tx.segmentConfig.findFirst({
        where: { organizationId: auth.organizationId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = (latest?.version ?? 0) + 1;
      if (activate) await this.deactivateAll(tx, auth.organizationId);
      const row = await tx.segmentConfig.create({
        data: {
          id: newId(),
          organizationId: auth.organizationId,
          version,
          config: config as object,
          isActive: activate,
          createdById: auth.userId,
        },
      });
      if (activate) await scheduleRecompute(tx, auth.organizationId, 0, 'segments');
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'segments.config_saved',
        entityType: 'segment_config',
        entityId: row.id,
        details: { version, activated: activate },
        ip,
      });
      return toVersion(row);
    });
  }

  async activate(
    auth: AuthContext,
    version: number,
    ip: string | null,
  ): Promise<SegmentConfigVersion> {
    return this.db.run(auth, async (tx) => {
      const target = await tx.segmentConfig.findFirst({
        where: { organizationId: auth.organizationId, version },
      });
      if (!target)
        throw new AppError('NOT_FOUND', `Segment configuration version ${version} not found`);
      await this.deactivateAll(tx, auth.organizationId);
      const row = await tx.segmentConfig.update({
        where: { id: target.id },
        data: { isActive: true },
      });
      await scheduleRecompute(tx, auth.organizationId, 0, 'segments');
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'segments.config_activated',
        entityType: 'segment_config',
        entityId: row.id,
        details: { version },
        ip,
      });
      return toVersion(row);
    });
  }

  /** Counts a configuration would produce today, computed by the analytics service. */
  async preview(auth: AuthContext, config: SegmentConfig): Promise<SegmentPreviewResponse> {
    return segmentPreviewResponseSchema.parse(
      await this.client.segmentPreview(auth.organizationId, config),
    );
  }

  /** Segment summary (SEG-04) from the latest successful snapshot. */
  async summary(auth: AuthContext): Promise<SegmentsResponse> {
    return this.db.run(auth, async (tx) => {
      const active = await this.ensureActive(tx, auth);
      const run = await tx.analyticsRun.findFirst({
        where: { organizationId: auth.organizationId, status: 'SUCCEEDED' },
        orderBy: { startedAt: 'desc' },
      });
      const configRow = run?.segmentConfigId
        ? ((await tx.segmentConfig.findUnique({ where: { id: run.segmentConfigId } })) ?? active)
        : active;
      const config = segmentConfigSchema.parse(configRow.config);
      const empty = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
      if (!run) {
        return {
          run: null,
          lookbackDays: config.lookbackDays,
          segments: [],
          noPurchases: 0,
          matrix: empty,
        };
      }

      // A snapshot never changes, so its aggregates are cached per run (M9 load test: this
      // scan of every customer's metrics dominated the segments endpoint under load).
      const cached = SNAPSHOT_AGGREGATES.get(run.id);
      const [rows, cells] =
        cached ??
        (await Promise.all([
          tx.$queryRaw<SummaryRow[]>`
          SELECT segment_key, count(*)::int AS customers, sum(m_value_cents)::bigint AS revenue,
                 avg(recency_days)::float8 AS avg_recency, avg(f_value)::float8 AS avg_orders,
                 avg(m_value_cents)::float8 AS avg_spend, avg(historical_clv_cents)::float8 AS avg_clv
          FROM analytics_customer_metrics
          WHERE organization_id = ${auth.organizationId}::uuid AND run_id = ${run.id}::uuid
          GROUP BY segment_key`,
          tx.$queryRaw<{ r: number; f: number; n: number }[]>`
          SELECT r_score AS r, f_score AS f, count(*)::int AS n
          FROM analytics_customer_metrics
          WHERE organization_id = ${auth.organizationId}::uuid AND run_id = ${run.id}::uuid
            AND r_score IS NOT NULL
          GROUP BY 1, 2`,
        ]));
      if (!cached) {
        SNAPSHOT_AGGREGATES.set(run.id, [rows, cells]);
        if (SNAPSHOT_AGGREGATES.size > 200) {
          SNAPSHOT_AGGREGATES.delete(SNAPSHOT_AGGREGATES.keys().next().value!);
        }
      }

      const scored = rows.filter((r) => r.segment_key !== null);
      const totalScored = scored.reduce((sum, r) => sum + r.customers, 0);
      const totalRevenue = scored.reduce((sum, r) => sum + toNumber(r.revenue), 0);
      const byKey = new Map(scored.map((r) => [r.segment_key!, r]));
      const segments = config.rules.map((rule) => {
        const row = byKey.get(rule.key);
        return {
          key: rule.key,
          name: rule.name,
          color: rule.color,
          description: rule.description,
          customers: row?.customers ?? 0,
          customerShare: totalScored ? (row?.customers ?? 0) / totalScored : 0,
          revenueShare: totalRevenue ? toNumber(row?.revenue) / totalRevenue : 0,
          avgRecencyDays: row?.avg_recency ?? null,
          avgOrders: row?.avg_orders ?? null,
          avgSpendCents: row?.avg_spend ?? null,
          avgClvCents: row?.avg_clv ?? null,
        };
      });
      const matrix = empty.map((r) => [...r]);
      for (const cell of cells) matrix[cell.r - 1]![cell.f - 1] = cell.n;

      return {
        run: {
          id: run.id,
          asOf: run.asOf.toISOString().slice(0, 10),
          configVersion: run.segmentConfigVersion,
        },
        lookbackDays: config.lookbackDays,
        segments,
        noPurchases: rows.find((r) => r.segment_key === null)?.customers ?? 0,
        matrix,
      };
    });
  }

  private async ensureActive(tx: Tx, auth: AuthContext): Promise<ConfigRow> {
    const active = await tx.segmentConfig.findFirst({
      where: { organizationId: auth.organizationId, isActive: true },
    });
    if (active) return active;
    const any = await tx.segmentConfig.count({ where: { organizationId: auth.organizationId } });
    if (any === 0) return seedSegmentConfig(tx, auth.organizationId, auth.userId);
    throw new AppError('CONFLICT', 'No active segment configuration');
  }

  private async deactivateAll(tx: Tx, organizationId: string): Promise<void> {
    await tx.segmentConfig.updateMany({
      where: { organizationId, isActive: true },
      data: { isActive: false },
    });
  }
}

export { NO_PURCHASES_SEGMENT };
