import type { Database } from '../../infra/database.js';
import type { HandlerRegistry } from '../../infra/job-dispatch.js';
import type { FileStorage } from '../../infra/storage.js';
import { ORG_EXPORT_JOB, PrivacyService } from './privacy.service.js';

export function privacyJobHandlers(deps: { db: Database; storage: FileStorage }): HandlerRegistry {
  const privacy = new PrivacyService(deps.db, deps.storage);
  return { [ORG_EXPORT_JOB]: (job) => privacy.generateExport(job) };
}
