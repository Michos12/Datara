import {
  definitionsResponseSchema,
  overviewResponseSchema,
  type AnalyticsStatus,
  type OverviewQuery,
  type OverviewResponse,
} from '@ci/contracts';
import type { z } from 'zod';
import type { AuthContext } from '../../core/request-context.js';
import type { AnalyticsClient } from '../../infra/analytics-client.js';
import { toNumber, type Database } from '../../infra/database.js';
import { scheduleRecompute } from '../../infra/job-queue.js';
import { recordAudit } from '../audit/audit.service.js';
import { cachedQuery, currentDataVersion, segmentRunId } from './query-cache.js';

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

  /** Business Overview for a period, served through the query cache. */
  async overview(auth: AuthContext, query: OverviewQuery): Promise<OverviewResponse> {
    const runId = await segmentRunId(this.db, auth, query.segment);
    const params = {
      start: query.start,
      end: query.end,
      compare: query.compare,
      grain: query.grain,
      segment: query.segment,
      runId,
    };
    return cachedQuery(this.db, auth, 'overview', params, overviewResponseSchema, () =>
      this.client.overview(auth.organizationId, params),
    );
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
