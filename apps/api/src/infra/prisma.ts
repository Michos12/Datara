import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export type { PrismaClient };
export type TransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Runtime Prisma client. Connects as app_user, which is subject to row-level security.
 * Services must not use this directly for tenant data: use withTenant() (and, from M1,
 * the tenant-scoped client extension built on it).
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

/**
 * Runs `fn` in a transaction with the tenant context set for RLS (ADR-0004).
 * `set_config(..., true)` is transaction-local, so the value never leaks to the next
 * request that reuses the pooled connection.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  organizationId: string,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${organizationId}, true)`;
    return fn(tx);
  });
}
