import { updateOrganizationRequestSchema } from '@ci/contracts';
import { Router } from 'express';
import { z } from 'zod';
import { clientIp, getAuth } from '../../core/request-context.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import type { TokenService } from '../auth/tokens.js';
import type { OrganizationService } from './organization.service.js';

const auditQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});

export function organizationRouter(deps: {
  organizations: OrganizationService;
  tokens: TokenService;
}): Router {
  const { organizations } = deps;
  const router = Router();
  router.use('/organization', requireAuth(deps.tokens));

  router.get('/organization', async (req, res) => {
    res.json(await organizations.get(getAuth(req)));
  });

  router.patch('/organization', requireRole('OWNER', 'ADMIN'), async (req, res) => {
    const body = updateOrganizationRequestSchema.parse(req.body);
    res.json(await organizations.update(getAuth(req), body, clientIp(req)));
  });

  router.get('/organization/audit-logs', requireRole('OWNER', 'ADMIN'), async (req, res) => {
    const query = auditQuerySchema.parse(req.query);
    res.json(await organizations.auditLog(getAuth(req), query));
  });

  return router;
}
