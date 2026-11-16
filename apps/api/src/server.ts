import { createApp } from './app.js';
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { AnalyticsClient } from './infra/analytics-client.js';
import { Database } from './infra/database.js';
import { createHealthChecks } from './infra/health-checks.js';
import { createPrismaClient } from './infra/prisma.js';

const config = loadConfig();
const logger = createLogger(config);
const prisma = createPrismaClient(config.databaseUrl);
const analytics = new AnalyticsClient(config.analytics.url, config.analytics.serviceToken);

const app = createApp({
  config,
  logger,
  health: createHealthChecks(prisma, analytics),
  database: new Database(prisma),
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'API listening');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
