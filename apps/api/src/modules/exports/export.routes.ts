import { currencyMinorUnits, customerListQuerySchema, type Customer } from '@ci/contracts';
import { stringify } from 'csv-stringify';
import { Router } from 'express';
import { once } from 'node:events';
import { clientIp, getAuth } from '../../core/request-context.js';
import type { Database } from '../../infra/database.js';
import { recordAudit } from '../audit/audit.service.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import type { TokenService } from '../auth/tokens.js';
import { listCustomers } from '../customers/customer.repository.js';

/**
 * Spreadsheet apps execute cells starting with = + - @ (or tab/CR) as formulas. Prefix them with
 * an apostrophe so exported customer data can never run as a formula (CSV injection).
 */
export function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

const COLUMNS = [
  'externalId',
  'firstName',
  'lastName',
  'email',
  'phone',
  'country',
  'region',
  'city',
  'registeredAt',
  'tags',
  'marketingConsent',
  'orderCount',
  'totalSpent',
  'averageOrder',
  'firstOrderAt',
  'lastOrderAt',
  'daysSinceLastOrder',
  'createdAt',
];

function toRow(c: Customer, digits: number): string[] {
  const money = (cents: number | null) =>
    cents === null ? '' : (cents / 10 ** digits).toFixed(digits);
  const cells = [
    c.externalId,
    c.firstName,
    c.lastName,
    c.email,
    c.phone,
    c.country,
    c.region,
    c.city,
    c.registeredAt,
    c.tags.join('|'),
    c.marketingConsent ? 'yes' : 'no',
    String(c.stats.orderCount),
    money(c.stats.totalNetCents),
    money(c.stats.aovCents),
    c.stats.firstOrderAt,
    c.stats.lastOrderAt,
    c.stats.daysSinceLastOrder === null ? '' : String(c.stats.daysSinceLastOrder),
    c.createdAt,
  ];
  return cells.map((v) => neutralizeFormula(v ?? ''));
}

/** CSV exports (RPT-01). Exports with personal data are limited by role and always audited. */
export function exportRouter(deps: {
  db: Database;
  tokens: TokenService;
  now?: () => number;
}): Router {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const router = Router();

  router.get(
    '/exports/customers.csv',
    requireAuth(deps.tokens),
    requireRole('OWNER', 'ADMIN', 'ANALYST'),
    async (req, res) => {
      const auth = getAuth(req);
      const filters = customerListQuerySchema.parse({ ...req.query, limit: 200 });
      const org = await db.run(auth, (tx) =>
        tx.organization.findUnique({
          where: { id: auth.organizationId },
          select: { currency: true, slug: true },
        }),
      );
      const digits = currencyMinorUnits(org?.currency.trim() ?? 'USD');

      res
        .type('text/csv; charset=utf-8')
        .attachment(`customers-${new Date(now()).toISOString().slice(0, 10)}.csv`);
      const csv = stringify({ header: true, columns: COLUMNS, bom: true });
      csv.pipe(res);

      let rows = 0;
      let cursor: string | undefined = filters.cursor;
      do {
        // Page through with the same keyset pagination as the list: memory stays flat.
        const page = await db.run(auth, (tx) =>
          listCustomers(tx, auth.organizationId, { ...filters, cursor }, now()),
        );
        for (const customer of page.data) {
          if (!csv.write(toRow(customer, digits))) await once(csv, 'drain');
          rows++;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      csv.end();

      await db.run(auth, (tx) =>
        recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.userId,
          action: 'export.customers',
          details: {
            rows,
            filters: Object.fromEntries(
              Object.entries(req.query).filter(([k]) => k !== 'cursor' && k !== 'limit'),
            ),
          },
          ip: clientIp(req),
        }),
      );
    },
  );

  return router;
}
