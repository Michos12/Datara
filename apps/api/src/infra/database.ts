import type { PrismaClient, TransactionClient } from './prisma.js';

/** A transaction-scoped client. Repositories receive this, never the root client. */
export type Tx = TransactionClient;

/**
 * Who a database transaction runs as, for row-level security (ADR-0004).
 * - organizationId: the active tenant; tenant tables are visible/writable only for it.
 * - userId: the signed-in user; lets them see their own memberships across organizations.
 * Omit both for tables without RLS (users, refresh_tokens); tenant tables then match no rows.
 */
export interface DbContext {
  organizationId?: string | null;
  userId?: string | null;
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
export class Database {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(context: DbContext, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT set_config('app.org_id', ${context.organizationId ?? ''}, true),
               set_config('app.user_id', ${context.userId ?? ''}, true)`;
      return work(tx);
    });
  }

  disconnect(): Promise<void> {
    return this.prisma.$disconnect();
  }
}
