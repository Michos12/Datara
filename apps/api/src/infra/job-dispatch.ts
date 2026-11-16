import type { Logger } from '../core/logger.js';
import type { ClaimedJob } from './job-queue.js';

/** Job types handled by the Node worker. `analytics.*` jobs belong to the Python worker. */
export const NODE_JOB_PREFIXES = ['import.', 'export.', 'report.'];

export type JobHandler = (job: ClaimedJob, ctx: { logger: Logger }) => Promise<void>;
export type HandlerRegistry = Record<string, JobHandler>;

export class UnknownJobTypeError extends Error {
  override name = 'UnknownJobTypeError';
}

/** Runs the handler registered for the job's type. Throws if none is registered. */
export async function dispatchJob(
  job: ClaimedJob,
  handlers: HandlerRegistry,
  logger: Logger,
): Promise<void> {
  const handler = handlers[job.type];
  if (!handler) throw new UnknownJobTypeError(`No handler registered for job type "${job.type}"`);
  await handler(job, { logger: logger.child({ jobId: job.id, jobType: job.type }) });
}
