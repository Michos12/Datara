import {
  createInvitationRequestSchema,
  updateMemberRequestSchema,
  updateOrganizationRequestSchema,
} from '@ci/contracts';
import { Router, type Request } from 'express';
import { AppError } from '../../core/errors.js';
import { z } from 'zod';
import { clientIp, getAuth } from '../../core/request-context.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import type { TokenService } from '../auth/tokens.js';
import type { OrganizationService } from './organization.service.js';
import type { TeamService } from './team.service.js';

function pathId(req: Request, name: 'userId' | 'id'): string {
  const parsed = z.uuid().safeParse(req.params[name]);
  if (!parsed.success) throw new AppError('NOT_FOUND', 'Not found');
  return parsed.data;
}

const MANAGERS = ['OWNER', 'ADMIN'] as const;

const auditQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});

export function organizationRouter(deps: {
  organizations: OrganizationService;
  team: TeamService;
  tokens: TokenService;
}): Router {
  const { organizations, team } = deps;
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

  // ───── members and invitations (AUTH-04) ─────
  router.get('/organization/members', requireRole(...MANAGERS), async (req, res) => {
    res.json({ data: await team.members(getAuth(req)) });
  });

  router.patch('/organization/members/:userId', requireRole(...MANAGERS), async (req, res) => {
    const body = updateMemberRequestSchema.parse(req.body);
    await team.updateRole(getAuth(req), pathId(req, 'userId'), body.role, clientIp(req));
    res.json({ data: await team.members(getAuth(req)) });
  });

  router.delete('/organization/members/:userId', requireRole(...MANAGERS), async (req, res) => {
    await team.remove(getAuth(req), pathId(req, 'userId'), clientIp(req));
    res.status(204).end();
  });

  router.get('/organization/invitations', requireRole(...MANAGERS), async (req, res) => {
    res.json({ data: await team.invitations(getAuth(req)) });
  });

  router.post('/organization/invitations', requireRole(...MANAGERS), async (req, res) => {
    const body = createInvitationRequestSchema.parse(req.body);
    res.status(201).json(await team.invite(getAuth(req), body, clientIp(req)));
  });

  router.delete('/organization/invitations/:id', requireRole(...MANAGERS), async (req, res) => {
    await team.revoke(getAuth(req), pathId(req, 'id'), clientIp(req));
    res.status(204).end();
  });

  return router;
}
