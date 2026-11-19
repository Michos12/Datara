import { Router, type RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../../core/errors.js';
import type { Database } from '../../infra/database.js';
import { recordRequest, renderMetrics } from '../../infra/metrics.js';

/** Records each request's latency under its route template (never the raw URL or IDs). */
export function requestMetrics(): RequestHandler {
  return (req, res, next) => {
    const started = performance.now();
    res.on('finish', () => {
      const route = req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';
      recordRequest(req.method, route, res.statusCode, (performance.now() - started) / 1000);
    });
    next();
  };
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = Buffer.from(header?.replace(/^Bearer /, '') ?? '');
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/**
 * Prometheus metrics for a scraper or uptime monitor. Off unless METRICS_TOKEN is set; the
 * queue gauges double as alerts (failed jobs in the last 24 hours, oldest pending job).
 */
export function metricsRouter(deps: { db: Database | undefined; token: string | null }): Router {
  const router = Router();
  router.get('/metrics', async (req, res) => {
    if (!deps.token) throw new AppError('NOT_FOUND', 'Not found');
    if (!tokenMatches(req.headers.authorization, deps.token)) {
      throw new AppError('UNAUTHENTICATED', 'Invalid metrics token');
    }
    const rows = deps.db
      ? await deps.db.run(
          {},
          (tx) =>
            // jobs has no RLS: these are cross-tenant counts, never per-tenant data.
            tx.$queryRaw<{ pending: number; oldest: number | null; failed: number }[]>`
            SELECT
              count(*) FILTER (WHERE status = 'PENDING' AND run_after <= now())::int AS pending,
              extract(epoch FROM now() - min(run_after) FILTER (
                WHERE status = 'PENDING' AND run_after <= now()))::float AS oldest,
              count(*) FILTER (WHERE status = 'FAILED'
                AND finished_at > now() - interval '24 hours')::int AS failed
            FROM jobs`,
        )
      : [];
    const g = rows[0] ?? { pending: 0, oldest: null, failed: 0 };
    res.type('text/plain; version=0.0.4').send(
      renderMetrics([
        { name: 'jobs_due', help: 'Jobs waiting to run now.', value: g.pending },
        {
          name: 'jobs_oldest_due_seconds',
          help: 'Age of the oldest job waiting to run (0 when none).',
          value: g.oldest ?? 0,
        },
        {
          name: 'jobs_failed_24h',
          help: 'Jobs that failed permanently in the last 24 hours (alert when > 0).',
          value: g.failed,
        },
      ]),
    );
  });
  return router;
}
