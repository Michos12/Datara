import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { HandlerRegistry } from '../../infra/job-dispatch.js';
import { enqueueJob } from '../../infra/job-queue.js';
import type { PrismaClient } from '../../infra/prisma.js';
import type { FileStorage } from '../../infra/storage.js';

export const MAINTENANCE_JOB = 'maintenance.cleanup';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Retention for data that belongs to no single tenant (docs/05-analytics-methodology.md §12):
 * tenant data (snapshots, audit log, invitations, query cache) is pruned per organization by the
 * nightly analytics recompute, which runs inside that organization's RLS context.
 */
export const RETENTION = {
  /** Finished background jobs (status history). */
  jobsDays: 30,
  /** Revoked or expired refresh tokens, used or expired reset links. */
  tokensDays: 7,
  /** Uploaded CSVs and their error reports. */
  importFilesDays: 30,
  /** Generated PDF reports and data exports. */
  generatedFilesDays: 7,
} as const;

/** Queues the daily cleanup unless one is pending (partial unique index: at most one). */
export async function scheduleMaintenance(
  prisma: PrismaClient,
  runAfter = new Date(),
): Promise<string | null> {
  return enqueueJob(prisma, { type: MAINTENANCE_JOB, organizationId: null, runAfter });
}

async function removeOldFiles(dir: string, olderThan: number): Promise<number> {
  let removed = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // nothing stored yet
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += await removeOldFiles(path, olderThan);
    } else if ((await stat(path)).mtimeMs < olderThan) {
      await rm(path, { force: true });
      removed += 1;
    }
  }
  return removed;
}

export async function cleanup(
  prisma: PrismaClient,
  storage: FileStorage,
  now = Date.now(),
): Promise<Record<string, number>> {
  const before = (days: number) => new Date(now - days * DAY_MS);
  const jobs = await prisma.$executeRaw`
    DELETE FROM jobs WHERE status IN ('SUCCEEDED', 'FAILED')
      AND finished_at < ${before(RETENTION.jobsDays)}`;
  const refreshTokens = await prisma.$executeRaw`
    DELETE FROM refresh_tokens
    WHERE expires_at < ${before(RETENTION.tokensDays)} OR revoked_at < ${before(RETENTION.tokensDays)}`;
  const resetTokens = await prisma.$executeRaw`
    DELETE FROM password_reset_tokens
    WHERE expires_at < ${before(RETENTION.tokensDays)} OR used_at < ${before(RETENTION.tokensDays)}`;
  const importFiles = await removeOldFiles(
    storage.path('imports/x').replace(/[\\/]x$/, ''),
    now - RETENTION.importFilesDays * DAY_MS,
  );
  let generated = 0;
  for (const dir of ['reports', 'exports']) {
    generated += await removeOldFiles(
      storage.path(`${dir}/x`).replace(/[\\/]x$/, ''),
      now - RETENTION.generatedFilesDays * DAY_MS,
    );
  }
  return { jobs, refreshTokens, resetTokens, importFiles, generatedFiles: generated };
}

export function maintenanceHandlers(deps: {
  prisma: PrismaClient;
  storage: FileStorage;
}): HandlerRegistry {
  return {
    [MAINTENANCE_JOB]: async (_job, { logger }) => {
      const removed = await cleanup(deps.prisma, deps.storage);
      logger.info({ removed }, 'maintenance cleanup finished');
      // The next run, tomorrow. (This job is still RUNNING, so the pending slot is free.)
      await scheduleMaintenance(deps.prisma, new Date(Date.now() + DAY_MS));
    },
  };
}
