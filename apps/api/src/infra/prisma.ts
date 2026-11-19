import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export type { PrismaClient };
export type TransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Runtime Prisma client. Connects as app_user, which is subject to row-level security.
 * Only infrastructure code uses it directly; application modules go through `Database.run`
 * (src/infra/database.ts), which sets the tenant context for every transaction.
 */
export function createPrismaClient(databaseUrl: string, poolSize = 10): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl, max: poolSize }),
  });
}
