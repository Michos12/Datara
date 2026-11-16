import { overviewQuerySchema } from '@ci/contracts';
import { Router } from 'express';
import { clientIp, getAuth } from '../../core/request-context.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import type { TokenService } from '../auth/tokens.js';
import type { AnalyticsService } from './analytics.service.js';

export function analyticsRouter(deps: {
  analytics: AnalyticsService;
  tokens: TokenService;
}): Router {
  const { analytics } = deps;
  const router = Router();
  router.use('/analytics', requireAuth(deps.tokens));

  router.get('/analytics/overview', async (req, res) => {
    res.json(await analytics.overview(getAuth(req), overviewQuerySchema.parse(req.query)));
  });

  router.get('/analytics/definitions', async (_req, res) => {
    res.json(await analytics.definitions());
  });

  /** Snapshot freshness, pending recompute, and the data-quality report of the last run. */
  router.get('/analytics/status', async (req, res) => {
    res.json(await analytics.status(getAuth(req)));
  });

  router.post('/analytics/runs', requireRole('OWNER', 'ADMIN', 'ANALYST'), async (req, res) => {
    await analytics.recompute(getAuth(req), clientIp(req));
    res.status(202).json(await analytics.status(getAuth(req)));
  });

  return router;
}
