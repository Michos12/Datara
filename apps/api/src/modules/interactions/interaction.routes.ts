import {
  batchInteractionsRequestSchema,
  createInteractionRequestSchema,
  interactionListQuerySchema,
} from '@ci/contracts';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { clientIp, getAuth } from '../../core/request-context.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import type { TokenService } from '../auth/tokens.js';
import type { InteractionService } from './interaction.service.js';

const idParam = z.uuid();

function pathId(req: Request): string {
  const parsed = idParam.safeParse(req.params.id);
  if (!parsed.success) throw new AppError('NOT_FOUND', 'Not found');
  return parsed.data;
}

const EDITORS = ['OWNER', 'ADMIN', 'ANALYST'] as const;
const DELETERS = ['OWNER', 'ADMIN'] as const;

/** Interactions CRUD (docs/04-api-spec.md §2.6) and a customer's interaction timeline. */
export function interactionRouter(deps: {
  interactions: InteractionService;
  tokens: TokenService;
}): Router {
  const { interactions } = deps;
  const router = Router();
  router.use(['/interactions', '/customers/:id/interactions'], requireAuth(deps.tokens));

  router.get('/interactions', async (req, res) => {
    res.json(await interactions.list(getAuth(req), interactionListQuerySchema.parse(req.query)));
  });

  router.post('/interactions', requireRole(...EDITORS), async (req, res) => {
    const body = createInteractionRequestSchema.parse(req.body);
    res.status(201).json(await interactions.create(getAuth(req), body));
  });

  router.post('/interactions/batch', requireRole(...EDITORS), async (req, res) => {
    const body = batchInteractionsRequestSchema.parse(req.body);
    res.json(await interactions.batch(getAuth(req), body));
  });

  router.delete('/interactions/:id', requireRole(...DELETERS), async (req, res) => {
    await interactions.remove(getAuth(req), pathId(req), clientIp(req));
    res.status(204).end();
  });

  router.get('/customers/:id/interactions', async (req, res) => {
    const query = interactionListQuerySchema.parse({ ...req.query, customerId: pathId(req) });
    res.json(await interactions.list(getAuth(req), query));
  });

  return router;
}
