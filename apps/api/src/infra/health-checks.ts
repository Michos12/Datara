import type { HealthChecks } from '../modules/health/health.routes.js';
import type { AnalyticsClient } from './analytics-client.js';
import type { PrismaClient } from './prisma.js';

export function createHealthChecks(prisma: PrismaClient, analytics: AnalyticsClient): HealthChecks {
  return {
    async database() {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    },
    async migrations() {
      // Ready when at least one migration is applied and none failed or is half-applied.
      const rows = await prisma.$queryRaw<{ applied: bigint; broken: bigint }[]>`
        SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
               count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS broken
        FROM _prisma_migrations`;
      const row = rows[0];
      return !!row && row.applied > 0n && row.broken === 0n;
    },
    analytics: () => analytics.isHealthy(),
  };
}
