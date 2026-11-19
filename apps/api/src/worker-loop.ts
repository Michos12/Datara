import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from './core/config.js';
import type { Logger } from './core/logger.js';
import { AnalyticsClient } from './infra/analytics-client.js';
import { Database } from './infra/database.js';
import { dispatchJob, NODE_JOB_PREFIXES, type HandlerRegistry } from './infra/job-dispatch.js';
import { claimJob, completeJob, failJob, type ClaimedJob } from './infra/job-queue.js';
import { recordJob } from './infra/metrics.js';
import type { PrismaClient } from './infra/prisma.js';
import { FileStorage } from './infra/storage.js';
import { AnalyticsService } from './modules/analytics/analytics.service.js';
import { BehaviorService } from './modules/analytics/behavior.service.js';
import { ValueService } from './modules/analytics/value.service.js';
import { importJobHandlers } from './modules/imports/import.jobs.js';
import {
  maintenanceHandlers,
  scheduleMaintenance,
} from './modules/maintenance/maintenance.jobs.js';
import { privacyJobHandlers } from './modules/privacy/privacy.jobs.js';
import { RecommendationService } from './modules/recommendations/recommendation.service.js';
import { PDF_REPORT_JOB, ReportService } from './modules/reports/report.service.js';
import { SegmentService } from './modules/segments/segment.service.js';

const IDLE_POLL_MS = 1000;

/** Every Node job handler (imports, reports, exports, maintenance). */
export function createHandlers(config: Config, prisma: PrismaClient): HandlerRegistry {
  const db = new Database(prisma);
  const storage = new FileStorage(config.storageDir);
  const client = new AnalyticsClient(config.analytics.url, config.analytics.serviceToken);
  const segments = new SegmentService(db, client);
  const reports = new ReportService({
    db,
    analytics: new AnalyticsService(db, client),
    behavior: new BehaviorService(db, client, segments),
    value: new ValueService(db, client),
    segments,
    recommendations: new RecommendationService(db, client),
    storage,
  });
  return {
    ...importJobHandlers({ db, storage }),
    ...privacyJobHandlers({ db, storage }),
    ...maintenanceHandlers({ prisma, storage }),
    [PDF_REPORT_JOB]: (job) => reports.generatePdf(job),
  };
}

/**
 * Claims and runs Node jobs until stopped. Runs as its own process (worker.ts) or inside the
 * API process (WORKER_IN_PROCESS) where uploads and reports must share one disk.
 */
export function startWorker(deps: { config: Config; logger: Logger; prisma: PrismaClient }) {
  const { prisma } = deps;
  const logger = deps.logger.child({ component: 'worker' });
  const handlers = createHandlers(deps.config, prisma);
  const workerId = `node-${hostname()}-${process.pid}`;
  let running = true;

  const loop = (async () => {
    await scheduleMaintenance(prisma).catch((err: unknown) =>
      logger.error({ err }, 'could not schedule maintenance'),
    );
    logger.info(
      { workerId, prefixes: NODE_JOB_PREFIXES, handlers: Object.keys(handlers) },
      'worker started',
    );
    while (running) {
      let job: ClaimedJob | null = null;
      try {
        job = await claimJob(prisma, workerId, NODE_JOB_PREFIXES);
        if (!job) {
          await sleep(IDLE_POLL_MS);
          continue;
        }
        const started = performance.now();
        await dispatchJob(job, handlers, logger);
        await completeJob(prisma, job.id);
        const seconds = (performance.now() - started) / 1000;
        recordJob(job.type, 'succeeded', seconds);
        logger.info({ jobId: job.id, type: job.type, seconds }, 'job succeeded');
      } catch (err) {
        if (job) {
          recordJob(job.type, 'failed', 0);
          // Attempts left: retried with backoff. Out of attempts: an error-level alert.
          const final = job.attempts >= job.maxAttempts;
          logger[final ? 'error' : 'warn'](
            { err, jobId: job.id, type: job.type, attempts: job.attempts, alert: final },
            final ? 'job failed permanently' : 'job failed, will retry',
          );
          await failJob(prisma, job, err instanceof Error ? err.message : String(err)).catch((e) =>
            logger.error({ err: e }, 'could not record job failure'),
          );
        } else {
          logger.error({ err }, 'job queue unavailable');
          await sleep(IDLE_POLL_MS * 5); // database trouble: back off before polling again
        }
      }
    }
    logger.info('worker stopped');
  })();

  return {
    async stop(): Promise<void> {
      running = false;
      await loop;
    },
  };
}
