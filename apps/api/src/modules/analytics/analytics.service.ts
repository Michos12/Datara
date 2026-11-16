import { createHash } from 'node:crypto';
import {
  definitionsResponseSchema,
  overviewResponseSchema,
  type AnalyticsStatus,
  type OverviewQuery,
  type OverviewResponse,
} from '@ci/contracts';
import type { z } from 'zod';
import { AppError } from '../../core/errors.js';
import type { AuthContext } from '../../core/request-context.js';
import type { AnalyticsClient } from '../../infra/analytics-client.js';
import { toNumber, type Database, type Tx } from '../../infra/database.js';
import { scheduleRecompute } from '../../infra/job-queue.js';
import { recordAudit } from '../audit/audit.service.js';

/** The analytics module is a facade: it caches and serves results, it never computes metrics. */
export class AnalyticsService {
  private definitionsCache: {
    at: number;
    value: z.infer<typeof definitionsResponseSchema>;
  } | null = null;

  constructor(
    private readonly db: Database,
    private readonly client: AnalyticsClient,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Business Overview for a period. Results are cached by (organization, params, data_version):
   * any data change bumps the version, so a cached answer is never stale (ADR-0009).
   */
  async overview(auth: AuthContext, query: OverviewQuery): Promise<OverviewResponse> {
    const params = {
      start: query.start,
      end: query.end,
      compare: query.compare,
      grain: query.grain,
    };
    const paramsHash = hashParams(params);
    const dataVersion = await this.db.run(auth, (tx) =>
      currentDataVersion(tx, auth.organizationId),
    );

    const hit = await this.db.run(auth, (tx) =>
      tx.analyticsQueryCache.findUnique({
        where: {
          organizationId_metric_paramsHash_dataVersion: {
            organizationId: auth.organizationId,
            metric: 'overview',
            paramsHash,
            dataVersion: BigInt(dataVersion),
          },
        },
      }),
    );
    if (hit) {
      const cached = overviewResponseSchema.parse(hit.result);
      return { ...cached, meta: { ...cached.meta, cached: true } };
    }

    const result = overviewResponseSchema.parse(
      await this.client.overview(auth.organizationId, params),
    );
    await this.db.run(auth, async (tx) => {
      // Store under the version the analytics service actually read; drop older versions.
      await tx.analyticsQueryCache.deleteMany({
        where: {
          organizationId: auth.organizationId,
          dataVersion: { lt: BigInt(result.meta.dataVersion) },
        },
      });
      await tx.analyticsQueryCache.upsert({
        where: {
          organizationId_metric_paramsHash_dataVersion: {
            organizationId: auth.organizationId,
            metric: 'overview',
            paramsHash,
            dataVersion: BigInt(result.meta.dataVersion),
          },
        },
        create: {
          organizationId: auth.organizationId,
          metric: 'overview',
          paramsHash,
          dataVersion: BigInt(result.meta.dataVersion),
          result: result as object,
        },
        update: { result: result as object },
      });
    });
    return { ...result, meta: { ...result.meta, cached: false } };
  }

  /** The metric registry (rarely changes: cached for 10 minutes per API process). */
  async definitions() {
    if (this.definitionsCache && this.now() - this.definitionsCache.at < 600_000) {
      return this.definitionsCache.value;
    }
    const value = definitionsResponseSchema.parse(await this.client.definitions());
    this.definitionsCache = { at: this.now(), value };
    return value;
  }

  async status(auth: AuthContext): Promise<AnalyticsStatus> {
    return this.db.run(auth, async (tx) => {
      const [run, dataVersion, pending] = await Promise.all([
        tx.analyticsRun.findFirst({
          where: { organizationId: auth.organizationId },
          orderBy: { startedAt: 'desc' },
        }),
        currentDataVersion(tx, auth.organizationId),
        tx.$queryRaw<{ run_after: Date; status: string }[]>`
          SELECT run_after, status::text AS status FROM jobs
          WHERE organization_id = ${auth.organizationId}::uuid AND type = 'analytics.recompute'
            AND status IN ('PENDING', 'RUNNING')
          ORDER BY run_after LIMIT 1`,
      ]);
      const lastSuccess =
        run?.status === 'SUCCEEDED'
          ? run
          : await tx.analyticsRun.findFirst({
              where: { organizationId: auth.organizationId, status: 'SUCCEEDED' },
              orderBy: { startedAt: 'desc' },
            });
      return {
        latestRun: run
          ? {
              id: run.id,
              status: run.status.toLowerCase() as 'running' | 'succeeded' | 'failed',
              asOf: run.asOf.toISOString().slice(0, 10),
              dataVersion: toNumber(run.dataVersion),
              startedAt: run.startedAt.toISOString(),
              finishedAt: run.finishedAt?.toISOString() ?? null,
              error: run.status === 'FAILED' ? 'The last analytics run failed' : null,
              stats: (run.stats ?? null) as Record<string, unknown> | null,
            }
          : null,
        stale: !lastSuccess || toNumber(lastSuccess.dataVersion) < dataVersion,
        // A nightly run is always scheduled after a successful run; only report work that is
        // running or due soon as "pending", and the rest as the next scheduled run.
        ...splitPending(pending[0], this.now()),
        dataVersion,
        dataQuality: (lastSuccess?.dataQuality ?? null) as Record<string, unknown> | null,
      };
    });
  }

  /** Recompute now (moves a pending debounced run forward). */
  async recompute(auth: AuthContext, ip: string | null): Promise<void> {
    await this.db.run(auth, async (tx) => {
      await scheduleRecompute(tx, auth.organizationId, 0, 'manual');
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'analytics.recompute',
        ip,
      });
    });
  }
}

const SOON_MS = 15 * 60_000;

export function splitPending(
  job: { run_after: Date; status: string } | undefined,
  now: number,
): { pending: { runAfter: string } | null; nextRunAt: string | null } {
  if (!job) return { pending: null, nextRunAt: null };
  const runAfter = job.run_after.toISOString();
  return job.status === 'RUNNING' || job.run_after.getTime() <= now + SOON_MS
    ? { pending: { runAfter }, nextRunAt: null }
    : { pending: null, nextRunAt: runAfter };
}

async function currentDataVersion(tx: Tx, organizationId: string): Promise<number> {
  const org = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { dataVersion: true },
  });
  if (!org) throw new AppError('NOT_FOUND', 'Organization not found');
  return toNumber(org.dataVersion);
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
