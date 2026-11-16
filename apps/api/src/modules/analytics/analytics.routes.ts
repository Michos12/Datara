import {
  behaviorSeriesQuerySchema,
  churnedCustomersQuerySchema,
  cohortsQuerySchema,
  overviewQuerySchema,
} from '@ci/contracts';
import { Router } from 'express';
import { clientIp, getAuth } from '../../core/request-context.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import type { TokenService } from '../auth/tokens.js';
import type { AnalyticsService } from './analytics.service.js';
import type { BehaviorService } from './behavior.service.js';

export function analyticsRouter(deps: {
  analytics: AnalyticsService;
  behavior: BehaviorService;
  tokens: TokenService;
}): Router {
  const { analytics, behavior } = deps;
  const router = Router();
  router.use('/analytics', requireAuth(deps.tokens));

  router.get('/analytics/overview', async (req, res) => {
    res.json(await analytics.overview(getAuth(req), overviewQuerySchema.parse(req.query)));
  });

  router.get('/analytics/retention', async (req, res) => {
    res.json(await behavior.retention(getAuth(req), behaviorSeriesQuerySchema.parse(req.query)));
  });

  router.get('/analytics/churn', async (req, res) => {
    res.json(await behavior.churn(getAuth(req), behaviorSeriesQuerySchema.parse(req.query)));
  });

  /** Names and emails of lapsed customers: not for viewers (docs/04-api-spec.md §2.9). */
  router.get(
    '/analytics/churn/customers',
    requireRole('OWNER', 'ADMIN', 'ANALYST'),
    async (req, res) => {
      res.json(
        await behavior.churnedCustomers(getAuth(req), churnedCustomersQuerySchema.parse(req.query)),
      );
    },
  );

  router.get('/analytics/cohorts', async (req, res) => {
    res.json(await behavior.cohorts(getAuth(req), cohortsQuerySchema.parse(req.query)));
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
