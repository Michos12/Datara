import { createApp } from './app.js';
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { AnalyticsClient } from './infra/analytics-client.js';
import { Database } from './infra/database.js';
import { createHealthChecks } from './infra/health-checks.js';
import { createPrismaClient } from './infra/prisma.js';
import { startWorker } from './worker-loop.js';

const config = loadConfig();
const logger = createLogger(config);
const prisma = createPrismaClient(config.databaseUrl, config.databasePoolSize);
const analytics = new AnalyticsClient(config.analytics.url, config.analytics.serviceToken);

const app = createApp({
  config,
  logger,
  health: createHealthChecks(prisma, analytics),
  database: new Database(prisma),
  analytics,
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'API listening');
});
// Single-disk deployments (Render): uploads and generated files live on the API's disk, so
// the job loop runs in this process instead of a separate worker service.
const worker = config.workerInProcess ? startWorker({ config, logger, prisma }) : null;

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  server.close();
  await worker?.stop();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
