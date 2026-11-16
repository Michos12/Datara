import type { AuditLogEntry, AuditLogPage } from '@ci/contracts';
import { newId } from '../../core/ids.js';
import type { Tx } from '../../infra/database.js';

export interface AuditEvent {
  organizationId: string;
  actorUserId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Append-only audit trail (PLT-01). Writes happen inside the caller's transaction so the audit
 * entry commits or rolls back with the change it describes. Never pass secrets or customer
 * personal data in `details`.
 */
export async function recordAudit(tx: Tx, event: AuditEvent): Promise<void> {
  await tx.auditLog.create({
    data: {
      id: newId(),
      organizationId: event.organizationId,
      actorUserId: event.actorUserId ?? null,
      action: event.action,
      entityType: event.entityType ?? null,
      entityId: event.entityId ?? null,
      details: (event.details ?? {}) as object,
      ip: event.ip ?? null,
    },
  });
}

/** Newest first. IDs are UUIDv7 (time-ordered), so the last ID is a stable cursor. */
export async function listAudit(
  tx: Tx,
  organizationId: string,
  { limit, cursor }: { limit: number; cursor?: string | undefined },
): Promise<AuditLogPage> {
  const rows = await tx.auditLog.findMany({
    where: { organizationId, ...(cursor ? { id: { lt: cursor } } : {}) },
    orderBy: { id: 'desc' },
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const data: AuditLogEntry[] = page.map((row) => ({
    id: row.id,
    action: row.action,
    actorUserId: row.actorUserId,
    entityType: row.entityType,
    entityId: row.entityId,
    details: (row.details ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  }));
  return {
    data,
    page: { nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null, limit },
  };
}
