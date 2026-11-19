import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { createPrismaClient } from './infra/prisma.js';
import { startWorker } from './worker-loop.js';

/** Standalone Node worker process (imports, reports, exports, maintenance). */
const config = loadConfig();
const logger = createLogger(config);
const prisma = createPrismaClient(config.databaseUrl, config.databasePoolSize);
const worker = startWorker({ config, logger, prisma });

async function shutdown(): Promise<void> {
  await worker.stop();
  await prisma.$disconnect();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
