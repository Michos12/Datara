import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { AppError } from '../../core/errors.js';
import type { AuthContext } from '../../core/request-context.js';
import { toNumber, type Database, type Tx } from '../../infra/database.js';

/**
 * Serves an analytics result from `analytics_query_cache`, or computes and stores it.
 * The key is (organization, metric, params, data_version): any data change bumps the version,
 * so a cached answer is never stale (ADR-0009). Results are stored under the version the
 * analytics service actually read, and older versions are dropped.
 */
export async function cachedQuery<T extends { meta: { dataVersion: number } }>(
  db: Database,
  auth: AuthContext,
  metric: string,
  params: Record<string, unknown>,
  schema: z.ZodType<T>,
  compute: () => Promise<unknown>,
): Promise<T & { meta: { cached: boolean } }> {
  const paramsHash = hashParams(params);
  const dataVersion = await db.run(auth, (tx) => currentDataVersion(tx, auth.organizationId));
  const key = (version: number) => ({
    organizationId_metric_paramsHash_dataVersion: {
      organizationId: auth.organizationId,
      metric,
      paramsHash,
      dataVersion: BigInt(version),
    },
  });

  const hit = await db.run(auth, (tx) =>
    tx.analyticsQueryCache.findUnique({ where: key(dataVersion) }),
  );
  if (hit) {
    const cached = schema.parse(hit.result);
    return { ...cached, meta: { ...cached.meta, cached: true } };
  }

  const result = schema.parse(await compute());
  await db.run(auth, async (tx) => {
    await tx.analyticsQueryCache.deleteMany({
      where: {
        organizationId: auth.organizationId,
        dataVersion: { lt: BigInt(result.meta.dataVersion) },
      },
    });
    await tx.analyticsQueryCache.upsert({
      where: key(result.meta.dataVersion),
      create: {
        organizationId: auth.organizationId,
        metric,
        paramsHash,
        dataVersion: BigInt(result.meta.dataVersion),
        result: result as object,
      },
      update: { result: result as object },
    });
  });
  return { ...result, meta: { ...result.meta, cached: false } };
}

export async function currentDataVersion(tx: Tx, organizationId: string): Promise<number> {
  const org = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { dataVersion: true },
  });
  if (!org) throw new AppError('NOT_FOUND', 'Organization not found');
  return toNumber(org.dataVersion);
}

/** The latest successful analytics run, or null before the first one. */
export async function latestRunId(tx: Tx, organizationId: string): Promise<string | null> {
  const run = await tx.analyticsRun.findFirst({
    where: { organizationId, status: 'SUCCEEDED' },
    orderBy: { startedAt: 'desc' },
    select: { id: true },
  });
  return run?.id ?? null;
}

/**
 * A segment filter depends on the latest snapshot's membership, which changes at each run even
 * without a data change: the run ID becomes part of the parameters, so of the cache key.
 */
export async function segmentRunId(
  db: Database,
  auth: AuthContext,
  segment: string | undefined,
): Promise<string | undefined> {
  if (!segment) return undefined;
  const run = await db.run(auth, (tx) => latestRunId(tx, auth.organizationId));
  if (!run) throw new AppError('CONFLICT', 'Segments are available after the first analytics run');
  return run;
}

export function hashParams(params: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
