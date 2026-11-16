import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { Database } from './infra/database.js';
import { dispatchJob, NODE_JOB_PREFIXES, type HandlerRegistry } from './infra/job-dispatch.js';
import { claimJob, completeJob, failJob, type ClaimedJob } from './infra/job-queue.js';
import { createPrismaClient } from './infra/prisma.js';
import { FileStorage } from './infra/storage.js';
import { importJobHandlers } from './modules/imports/import.jobs.js';

const IDLE_POLL_MS = 1000;

const config = loadConfig();
const logger = createLogger(config).child({ component: 'worker' });
const prisma = createPrismaClient(config.databaseUrl);
const workerId = `node-${hostname()}-${process.pid}`;

const handlers: HandlerRegistry = {
  ...importJobHandlers({ db: new Database(prisma), storage: new FileStorage(config.storageDir) }),
};

let running = true;
process.on('SIGTERM', () => (running = false));
process.on('SIGINT', () => (running = false));

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
    await dispatchJob(job, handlers, logger);
    await completeJob(prisma, job.id);
    logger.info({ jobId: job.id, type: job.type }, 'job succeeded');
  } catch (err) {
    logger.error({ err, jobId: job?.id }, 'job failed');
    if (job) {
      await failJob(prisma, job, err instanceof Error ? err.message : String(err)).catch((e) =>
        logger.error({ err: e }, 'could not record job failure'),
      );
    } else {
      await sleep(IDLE_POLL_MS * 5); // database trouble: back off before polling again
    }
  }
}
await prisma.$disconnect();
logger.info('worker stopped');
