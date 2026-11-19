import { Router, type Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { clientIp, getAuth } from '../../core/request-context.js';
import type { FileStorage } from '../../infra/storage.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import { clearSessionCookies, type CookieSettings } from '../auth/cookies.js';
import type { TokenService } from '../auth/tokens.js';
import type { PrivacyService } from './privacy.service.js';

const eraseSchema = z.strictObject({ mode: z.enum(['anonymize', 'delete']) });
const deleteOrgSchema = z.strictObject({ confirmName: z.string().min(1).max(200) });

function uuidParam(req: Request, label: string): string {
  const parsed = z.uuid().safeParse(req.params.id);
  if (!parsed.success) throw new AppError('NOT_FOUND', `${label} not found`);
  return parsed.data;
}

/** Right to erasure, organization export and organization deletion (CUS-10, NFR-PRV-02). */
export function privacyRouter(deps: {
  privacy: PrivacyService;
  storage: FileStorage;
  tokens: TokenService;
  cookies: CookieSettings;
}): Router {
  const { privacy, storage } = deps;
  const router = Router();
  const auth = requireAuth(deps.tokens);

  router.post('/customers/:id/erase', auth, requireRole('OWNER', 'ADMIN'), async (req, res) => {
    const { mode } = eraseSchema.parse(req.body);
    await privacy.eraseCustomer(getAuth(req), uuidParam(req, 'Customer'), mode, clientIp(req));
    res.status(204).end();
  });

  router.post('/organization/export', auth, requireRole('OWNER'), async (req, res) => {
    res.status(202).json({ jobId: await privacy.requestExport(getAuth(req), clientIp(req)) });
  });

  router.get('/organization/export/:id', auth, requireRole('OWNER'), async (req, res) => {
    const { fileKey: _key, ...job } = await privacy.exportJob(
      getAuth(req),
      uuidParam(req, 'Export'),
    );
    res.json(job);
  });

  router.get('/organization/export/:id/file', auth, requireRole('OWNER'), async (req, res) => {
    const job = await privacy.exportJob(getAuth(req), uuidParam(req, 'Export'));
    if (job.status !== 'succeeded' || !job.fileKey || !(await storage.exists(job.fileKey))) {
      throw new AppError('NOT_FOUND', 'The export is not ready');
    }
    res.type('application/zip').attachment(job.fileName ?? 'export.zip');
    storage.read(job.fileKey).pipe(res);
  });

  router.delete('/organization', auth, requireRole('OWNER'), async (req, res) => {
    const { confirmName } = deleteOrgSchema.parse(req.body);
    await privacy.deleteOrganization(getAuth(req), confirmName);
    clearSessionCookies(res, deps.cookies);
    res.status(204).end();
  });

  return router;
}
