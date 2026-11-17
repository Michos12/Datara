import type {
  BatchInteractionsRequest,
  BatchInteractionsResponse,
  CreateInteractionRequest,
  Interaction,
  InteractionListQuery,
  InteractionPage,
  InteractionType,
} from '@ci/contracts';
import { AppError, type FieldError } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import type { AuthContext } from '../../core/request-context.js';
import { join, recordDataChange, sql, type Database, type Tx } from '../../infra/database.js';
import { recordAudit } from '../audit/audit.service.js';

type DbType =
  | 'WEBSITE_VISIT'
  | 'EMAIL_SENT'
  | 'EMAIL_OPENED'
  | 'EMAIL_CLICKED'
  | 'SUPPORT_TICKET'
  | 'REVIEW'
  | 'LOYALTY_SIGNUP'
  | 'CAMPAIGN_RESPONSE'
  | 'OTHER';
export const toDbType = (type: InteractionType) => type.toUpperCase() as DbType;
const fromDbType = (type: DbType) => type.toLowerCase() as InteractionType;

/** Like orders: backdating is fine, more than a day in the future is not. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

interface InteractionRow {
  id: string;
  customerId: string;
  externalId: string | null;
  type: DbType;
  channel: string | null;
  occurredAt: Date;
  metadata: unknown;
  createdAt: Date;
}

function toInteraction(row: InteractionRow): Interaction {
  return {
    id: row.id,
    customerId: row.customerId,
    externalId: row.externalId,
    type: fromDbType(row.type),
    channel: row.channel,
    occurredAt: row.occurredAt.toISOString(),
    metadata:
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdAt: row.createdAt.toISOString(),
  };
}

interface Parsed {
  customerId: string;
  type: InteractionType;
  occurredAt: string;
  channel?: string | null | undefined;
  externalId?: string | null | undefined;
  metadata?: Record<string, string | number | boolean | null> | undefined;
}

/**
 * Interactions (CUS-06): non-purchase events that feed engagement analytics. Writes bump the
 * organization's data version and schedule a recompute, like orders. Rows with an external ID
 * are upserted, so re-sending a batch is safe.
 */
export class InteractionService {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async list(auth: AuthContext, query: InteractionListQuery): Promise<InteractionPage> {
    const rows = await this.db.run(auth, async (tx) => {
      if (query.customerId) await this.assertCustomers(tx, auth.organizationId, [query.customerId]);
      return tx.interaction.findMany({
        where: {
          organizationId: auth.organizationId,
          customer: { deletedAt: null },
          ...(query.customerId ? { customerId: query.customerId } : {}),
          ...(query.type ? { type: toDbType(query.type) } : {}),
          ...(query.from || query.to
            ? {
                occurredAt: {
                  ...(query.from ? { gte: new Date(query.from) } : {}),
                  ...(query.to ? { lt: new Date(query.to) } : {}),
                },
              }
            : {}),
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });
    });
    const page = rows.slice(0, query.limit);
    return {
      data: page.map(toInteraction),
      page: {
        nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
        limit: query.limit,
      },
    };
  }

  async create(auth: AuthContext, input: CreateInteractionRequest): Promise<Interaction> {
    const parsed = input as Parsed;
    this.checkDates([parsed]);
    return this.db.run(auth, async (tx) => {
      await this.assertCustomers(tx, auth.organizationId, [parsed.customerId]);
      const [written] = await upsert(tx, auth.organizationId, [parsed]);
      await recordDataChange(tx, auth.organizationId);
      const row = await tx.interaction.findUniqueOrThrow({ where: { id: written!.id } });
      return toInteraction(row);
    });
  }

  async batch(
    auth: AuthContext,
    input: BatchInteractionsRequest,
  ): Promise<BatchInteractionsResponse> {
    const rows = input.interactions as Parsed[];
    this.checkDates(rows);
    const seen = new Map<string, number>();
    const duplicates: FieldError[] = [];
    rows.forEach((row, index) => {
      if (!row.externalId) return;
      if (seen.has(row.externalId)) {
        duplicates.push({
          path: `interactions.${index}.externalId`,
          message: `Same external ID as interactions.${seen.get(row.externalId)}`,
        });
      } else seen.set(row.externalId, index);
    });
    if (duplicates.length > 0) {
      throw new AppError('VALIDATION_FAILED', 'Duplicate external IDs in the batch', duplicates);
    }
    return this.db.run(auth, async (tx) => {
      await this.assertCustomers(
        tx,
        auth.organizationId,
        rows.map((r) => r.customerId),
      );
      const written = await upsert(tx, auth.organizationId, rows);
      await recordDataChange(tx, auth.organizationId);
      const inserted = written.filter((w) => w.inserted).length;
      return { inserted, updated: written.length - inserted };
    });
  }

  async remove(auth: AuthContext, id: string, ip: string | null): Promise<void> {
    await this.db.run(auth, async (tx) => {
      const { count } = await tx.interaction.deleteMany({
        where: { id, organizationId: auth.organizationId },
      });
      if (count === 0) throw new AppError('NOT_FOUND', 'Interaction not found');
      await recordDataChange(tx, auth.organizationId);
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'interaction.delete',
        entityType: 'interaction',
        entityId: id,
        ip,
      });
    });
  }

  private checkDates(rows: Parsed[]): void {
    const latest = this.now() + FUTURE_TOLERANCE_MS;
    const errors: FieldError[] = [];
    rows.forEach((row, index) => {
      if (new Date(row.occurredAt).getTime() > latest) {
        errors.push({
          path: rows.length > 1 ? `interactions.${index}.occurredAt` : 'occurredAt',
          message: 'Cannot be more than one day in the future',
        });
      }
    });
    if (errors.length > 0) {
      throw new AppError('VALIDATION_FAILED', 'Interaction date is in the future', errors);
    }
  }

  /** 404 for a single unknown customer; 422 naming every unknown one in a batch. */
  private async assertCustomers(tx: Tx, organizationId: string, ids: string[]): Promise<void> {
    const unique = [...new Set(ids)];
    const found = await tx.customer.findMany({
      where: { id: { in: unique }, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (found.length === unique.length) return;
    if (ids.length === 1) throw new AppError('NOT_FOUND', 'Customer not found');
    const known = new Set(found.map((c) => c.id));
    const errors = ids.flatMap((id, index) =>
      known.has(id)
        ? []
        : [{ path: `interactions.${index}.customerId`, message: 'No such customer' }],
    );
    throw new AppError('VALIDATION_FAILED', 'Unknown customers in the batch', errors.slice(0, 50));
  }
}

/** Inserts the rows; rows whose external ID already exists are updated instead. */
async function upsert(
  tx: Tx,
  organizationId: string,
  rows: Parsed[],
): Promise<{ id: string; inserted: boolean }[]> {
  const values = rows.map(
    (row) => sql`(${newId()}::uuid, ${organizationId}::uuid, ${row.customerId}::uuid,
      ${row.externalId ?? null}::text, ${toDbType(row.type)}::"InteractionType",
      ${row.channel ?? null}::text, ${new Date(row.occurredAt)}::timestamptz,
      ${JSON.stringify(row.metadata ?? {})}::jsonb)`,
  );
  // xmax = 0 on a returned row means it was inserted rather than updated by ON CONFLICT.
  return tx.$queryRaw<{ id: string; inserted: boolean }[]>`
    INSERT INTO interactions (id, organization_id, customer_id, external_id, type, channel,
                              occurred_at, metadata)
    VALUES ${join(values, ', ')}
    ON CONFLICT (organization_id, external_id) DO UPDATE SET
      customer_id = EXCLUDED.customer_id, type = EXCLUDED.type, channel = EXCLUDED.channel,
      occurred_at = EXCLUDED.occurred_at, metadata = EXCLUDED.metadata
    RETURNING id::text AS id, (xmax = 0) AS inserted`;
}
