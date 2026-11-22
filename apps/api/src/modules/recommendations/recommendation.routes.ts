import {
  currencyMinorUnits,
  recommendationCustomersQuerySchema,
  recommendationListQuerySchema,
  updateRecommendationRequestSchema,
} from '@ci/contracts';
import { stringify } from 'csv-stringify';
import { Router, type Request } from 'express';
import { once } from 'node:events';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { clientIp, getAuth } from '../../core/request-context.js';
import type { Database } from '../../infra/database.js';
import { recordAudit } from '../audit/audit.service.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import { limitExpensive } from '../auth/session-policy.js';
import type { TokenService } from '../auth/tokens.js';
import { neutralizeFormula } from '../exports/export.routes.js';
import type { RecommendationService } from './recommendation.service.js';

const idParam = z.uuid();

function pathId(req: Request): string {
  const parsed = idParam.safeParse(req.params.id);
  if (!parsed.success) throw new AppError('NOT_FOUND', 'Not found');
  return parsed.data;
}

const EDITORS = ['OWNER', 'ADMIN', 'ANALYST'] as const;

/** Recommendations inbox (docs/04-api-spec.md §2.10). */
export function recommendationRouter(deps: {
  recommendations: RecommendationService;
  db: Database;
  tokens: TokenService;
}): Router {
  const { recommendations, db } = deps;
  const router = Router();
  router.use('/recommendations', requireAuth(deps.tokens));

  router.get('/recommendations', async (req, res) => {
    const query = recommendationListQuerySchema.parse(req.query);
    res.json(await recommendations.list(getAuth(req), query));
  });

  router.get('/recommendations/rules', requireRole('OWNER', 'ADMIN'), async (_req, res) => {
    res.json(await recommendations.rules());
  });

  router.get('/recommendations/:id', async (req, res) => {
    res.json(await recommendations.get(getAuth(req), pathId(req)));
  });

  router.patch('/recommendations/:id', requireRole(...EDITORS), async (req, res) => {
    const body = updateRecommendationRequestSchema.parse(req.body);
    res.json(await recommendations.update(getAuth(req), pathId(req), body, clientIp(req)));
  });

  /** Names and emails: not for viewers. */
  router.get('/recommendations/:id/customers', requireRole(...EDITORS), async (req, res) => {
    const query = recommendationCustomersQuerySchema.parse(req.query);
    res.json(await recommendations.customers(getAuth(req), pathId(req), query));
  });

  router.get(
    '/recommendations/:id/customers.csv',
    requireRole(...EDITORS),
    limitExpensive(deps.tokens),
    async (req, res) => {
      const auth = getAuth(req);
      const id = pathId(req);
      const recommendation = await recommendations.get(auth, id);
      const org = await db.run(auth, (tx) =>
        tx.organization.findUnique({
          where: { id: auth.organizationId },
          select: { currency: true },
        }),
      );
      const currency = org?.currency.trim() ?? 'USD';
      const digits = currencyMinorUnits(currency);

      res.type('text/csv; charset=utf-8').attachment(`${recommendation.ruleKey}-customers.csv`);
      const csv = stringify({
        header: true,
        bom: true,
        columns: [
          'customer_id',
          'external_id',
          'first_name',
          'last_name',
          'email',
          `net_last_12_months_${currency}`,
          'segment',
          'last_order_date',
        ],
      });
      csv.pipe(res);
      let rows = 0;
      for await (const c of recommendations.allCustomers(auth, id)) {
        const cells = [
          c.customerId,
          c.externalId,
          c.firstName,
          c.lastName,
          c.email,
          (c.valueCents / 10 ** digits).toFixed(digits),
          c.segment,
          c.lastOrderDate,
        ].map((v) => neutralizeFormula(v ?? ''));
        if (!csv.write(cells)) await once(csv, 'drain');
        rows++;
      }
      // Audit before the response ends, so the record exists once the download completes.
      await db.run(auth, (tx) =>
        recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.userId,
          action: 'export.recommendation_customers',
          entityType: 'recommendation',
          entityId: id,
          details: { rows, rule: recommendation.ruleKey },
          ip: clientIp(req),
        }),
      );
      csv.end();
    },
  );

  return router;
}
