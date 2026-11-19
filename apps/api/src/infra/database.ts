import { Prisma } from '../generated/prisma/client.js';
import { scheduleRecompute } from './job-queue.js';
import type { PrismaClient, TransactionClient } from './prisma.js';

/**
 * Tagged-template SQL helpers for the few queries Prisma's query builder cannot express
 * (keyset pagination over aggregates, bulk upserts). Values are always bound parameters;
 * `raw` is only for whitelisted identifiers and fragments, never user input.
 */
export const sql = Prisma.sql;
export const join = Prisma.join;
export const raw = Prisma.raw;
export const empty = Prisma.empty;
export type SqlFragment = Prisma.Sql;

/** Records a change to tenant data. Analytics caches and snapshots key on this (ADR-0009). */
export async function bumpDataVersion(
  tx: TransactionClient,
  organizationId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE organizations SET data_version = data_version + 1 WHERE id = ${organizationId}::uuid`;
}

/** Edits made through the UI or API: wait for a quiet moment before recomputing. */
export const EDIT_RECOMPUTE_DELAY_MS = 10 * 60 * 1000;

/**
 * Every change that affects analytics: bumps the data version (invalidating cached queries) and
 * schedules a recompute of the snapshot (debounced by the one-pending-job rule).
 */
export async function recordDataChange(
  tx: TransactionClient,
  organizationId: string,
  {
    delayMs = EDIT_RECOMPUTE_DELAY_MS,
    trigger = 'edit',
  }: { delayMs?: number; trigger?: string } = {},
): Promise<void> {
  await bumpDataVersion(tx, organizationId);
  await scheduleRecompute(tx, organizationId, delayMs, trigger);
}

/** BigInt money columns fit safely in a JS number (< 2^53 minor units). */
export function toNumber(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}

/** A transaction-scoped client. Repositories receive this, never the root client. */
export type Tx = TransactionClient;

/**
 * Who a database transaction runs as, for row-level security (ADR-0004).
 * - organizationId: the active tenant; tenant tables are visible/writable only for it.
 * - userId: the signed-in user; lets them see their own memberships across organizations.
 * - invitationTokenHash: during public invitation acceptance, makes that one invitation visible.
 * Omit all for tables without RLS (users, refresh_tokens); tenant tables then match no rows.
 */
export interface DbContext {
  organizationId?: string | null;
  userId?: string | null;
  invitationTokenHash?: string | null;
}

/** Postgres error code reported by Prisma for unique constraint violations. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/**
 * Application database access. Every unit of work runs in one transaction that first sets
 * the tenant context with transaction-local `set_config`, so the context can never leak to
 * another request through the connection pool.
 *
 * Application code must still filter by organization explicitly (layer 1); RLS is the
 * independent backstop (layer 2).
 */
/** Wait for a pooled connection, and how long one unit of work may hold it. */
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

export class Database {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(context: DbContext, work: (tx: Tx) => Promise<T>): Promise<T> {
    // Under load a request waits up to 10 s for a pooled connection instead of failing after
    // Prisma's default 2 s (M9 load test).
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT set_config('app.org_id', ${context.organizationId ?? ''}, true),
               set_config('app.user_id', ${context.userId ?? ''}, true),
               set_config('app.invitation_token', ${context.invitationTokenHash ?? ''}, true)`;
      return work(tx);
    }, TRANSACTION_OPTIONS);
  }

  disconnect(): Promise<void> {
    return this.prisma.$disconnect();
  }
}
