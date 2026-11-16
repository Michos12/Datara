import { newId } from '../core/ids.js';
import type { PrismaClient, TransactionClient } from './prisma.js';

/** Anything that can run raw SQL: the root client or a transaction (enqueue atomically with a change). */
type SqlRunner = Pick<TransactionClient, '$executeRaw'>;

/**
 * Postgres-backed job queue (ADR-0003). Workers claim with FOR UPDATE SKIP LOCKED, so
 * several workers can poll the same table without double-processing a job.
 * The Python analytics worker implements the same protocol for `analytics.*` jobs.
 */

export interface ClaimedJob {
  id: string;
  organizationId: string | null;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueInput {
  type: string;
  organizationId?: string | null;
  payload?: Record<string, unknown>;
  runAfter?: Date;
}

/** A RUNNING job whose lock is older than this is considered abandoned and reclaimed. */
export const STALE_LOCK_MINUTES = 15;

/** Exponential backoff: 30 s, 2 min, 8 min, ... capped at 1 hour. */
export function retryDelayMs(attempts: number): number {
  const delay = 30_000 * 4 ** Math.max(0, attempts - 1);
  return Math.min(delay, 60 * 60_000);
}

/**
 * Inserts a job and returns its ID, or null if a uniqueness rule (e.g. one pending recompute
 * per organization) suppressed it.
 */
export async function enqueueJob(
  prisma: SqlRunner | PrismaClient,
  input: EnqueueInput,
): Promise<string | null> {
  const id = newId();
  const inserted = await prisma.$executeRaw`
    INSERT INTO jobs (id, organization_id, type, payload, run_after)
    VALUES (
      ${id}::uuid,
      ${input.organizationId ?? null}::uuid,
      ${input.type},
      ${JSON.stringify(input.payload ?? {})}::jsonb,
      ${input.runAfter ?? new Date()}
    )
    ON CONFLICT DO NOTHING`;
  return inserted === 1 ? id : null;
}

interface JobRow {
  id: string;
  organization_id: string | null;
  type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

/** Claims the next due job whose type starts with one of `typePrefixes`. */
export async function claimJob(
  prisma: PrismaClient,
  workerId: string,
  typePrefixes: string[],
): Promise<ClaimedJob | null> {
  const patterns = typePrefixes.map((prefix) => `${prefix}%`);
  const rows = await prisma.$queryRaw<JobRow[]>`
    UPDATE jobs
    SET status = 'RUNNING', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE type LIKE ANY(${patterns}::text[])
        AND (
          (status = 'PENDING' AND run_after <= now())
          OR (status = 'RUNNING' AND locked_at < now() - make_interval(mins => ${STALE_LOCK_MINUTES}))
        )
      ORDER BY run_after
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, organization_id, type, payload, attempts, max_attempts`;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    type: row.type,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

export async function completeJob(prisma: PrismaClient, jobId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE jobs SET status = 'SUCCEEDED', finished_at = now(), locked_at = NULL, error = NULL
    WHERE id = ${jobId}::uuid`;
}

/** Records a failure: retries later with backoff, or marks FAILED after max attempts. */
export async function failJob(
  prisma: PrismaClient,
  job: ClaimedJob,
  message: string,
): Promise<void> {
  if (job.attempts >= job.maxAttempts) {
    await prisma.$executeRaw`
      UPDATE jobs SET status = 'FAILED', finished_at = now(), locked_at = NULL, error = ${message}
      WHERE id = ${job.id}::uuid`;
    return;
  }
  const runAfter = new Date(Date.now() + retryDelayMs(job.attempts));
  await prisma.$executeRaw`
    UPDATE jobs SET status = 'PENDING', run_after = ${runAfter}, locked_at = NULL, locked_by = NULL,
                    error = ${message}
    WHERE id = ${job.id}::uuid`;
}
