import { pipeline } from 'node:stream/promises';
import {
  comparisonQuerySchema,
  currencyMinorUnits,
  exportableMetricSchema,
  orderListQuerySchema,
  overviewQuerySchema,
} from '@ci/contracts';
import { stringify } from 'csv-stringify';
import { Router, type Request, type Response } from 'express';
import { once } from 'node:events';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { clientIp, getAuth } from '../../core/request-context.js';
import type { Database } from '../../infra/database.js';
import type { FileStorage } from '../../infra/storage.js';
import { recordAudit } from '../audit/audit.service.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import { limitExpensive } from '../auth/session-policy.js';
import type { TokenService } from '../auth/tokens.js';
import { neutralizeFormula } from '../exports/export.routes.js';
import type { OrderService } from '../orders/order.service.js';
import type { ReportService } from './report.service.js';
import type { Cell, Table } from './tables.js';

const EDITORS = ['OWNER', 'ADMIN', 'ANALYST'] as const;

/** CSV cell: text is formula-neutralised, numbers and booleans are written as they are. */
export function csvCell(value: Cell): string {
  if (value === null) return '';
  if (typeof value === 'string') return neutralizeFormula(value);
  return String(value);
}

/** Sends a table as a CSV download: UTF-8 with BOM (Excel), comma-separated, CRLF rows. */
export function sendCsv(res: Response, fileName: string, table: Table): void {
  res.type('text/csv; charset=utf-8').attachment(fileName);
  const csv = stringify({
    header: true,
    columns: table.columns,
    bom: true,
    record_delimiter: 'windows',
  });
  csv.pipe(res);
  for (const row of table.rows) csv.write(row.map(csvCell));
  csv.end();
}

function jobId(req: Request): string {
  const parsed = z.uuid().safeParse(req.params.id);
  if (!parsed.success) throw new AppError('NOT_FOUND', 'Report not found');
  return parsed.data;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Reports and exports (docs/04-api-spec.md §2.11). */
export function reportRouter(deps: {
  reports: ReportService;
  orders: OrderService;
  db: Database;
  storage: FileStorage;
  tokens: TokenService;
}): Router {
  const { reports, orders, db, storage } = deps;
  const router = Router();
  router.use(
    [
      '/reports',
      '/exports/kpis.csv',
      '/exports/analytics',
      '/exports/comparison.csv',
      '/exports/orders.csv',
    ],
    requireAuth(deps.tokens),
  );
  // Every CSV export and PDF request counts towards the organization's export limit.
  router.use('/exports', limitExpensive(deps.tokens));
  router.post('/reports/pdf', limitExpensive(deps.tokens));

  router.get('/reports/comparison', async (req, res) => {
    res.json(await reports.comparison(getAuth(req), comparisonQuerySchema.parse(req.query)));
  });

  router.get('/exports/comparison.csv', async (req, res) => {
    const query = comparisonQuerySchema.parse(req.query);
    const table = await reports.comparisonTable(getAuth(req), query);
    sendCsv(res, `comparison-${query.aStart}-vs-${query.bStart}.csv`, table);
  });

  router.get('/exports/kpis.csv', async (req, res) => {
    const query = overviewQuerySchema.parse(req.query);
    const table = await reports.kpiTable(getAuth(req), query);
    sendCsv(res, `kpis-${query.start ?? today()}.csv`, table);
  });

  router.get('/exports/analytics/:metric.csv', async (req, res) => {
    const metric = exportableMetricSchema.safeParse(req.params.metric);
    if (!metric.success) throw new AppError('NOT_FOUND', 'Unknown metric');
    const table = await reports.analyticsTable(getAuth(req), metric.data, req.query);
    sendCsv(res, `${metric.data}-${today()}.csv`, table);
  });

  /** Streamed, keyset-paged, audited: orders carry customer IDs (RPT-07). */
  router.get('/exports/orders.csv', requireRole(...EDITORS), async (req, res) => {
    const auth = getAuth(req);
    const filters = orderListQuerySchema.parse({ ...req.query, limit: 200 });
    const org = await db.run(auth, (tx) =>
      tx.organization.findUnique({
        where: { id: auth.organizationId },
        select: { currency: true },
      }),
    );
    const currency = org?.currency.trim() ?? 'USD';
    const digits = currencyMinorUnits(currency);
    const money = (cents: number) => (cents / 10 ** digits).toFixed(digits);
    res.type('text/csv; charset=utf-8').attachment(`orders-${today()}.csv`);
    const csv = stringify({
      header: true,
      bom: true,
      record_delimiter: 'windows',
      columns: [
        'order_id',
        'external_id',
        'customer_id',
        'ordered_at',
        'status',
        'channel',
        `gross_${currency}`,
        `discount_${currency}`,
        `tax_${currency}`,
        `refunded_${currency}`,
        `net_${currency}`,
      ],
    });
    csv.pipe(res);
    let rows = 0;
    let cursor = filters.cursor;
    do {
      const page = await orders.list(auth, { ...filters, cursor });
      for (const o of page.data) {
        const cells = [
          o.id,
          o.externalId,
          o.customerId,
          o.orderedAt,
          o.status,
          o.channel,
          money(o.grossCents),
          money(o.discountCents),
          money(o.taxCents),
          money(o.refundedCents),
          money(o.netCents),
        ].map((v) => csvCell(v));
        if (!csv.write(cells)) await once(csv, 'drain');
        rows++;
      }
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor);
    // Audit before the response ends, so the record exists once the download completes.
    await db.run(auth, (tx) =>
      recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'export.orders',
        details: { rows },
        ip: clientIp(req),
      }),
    );
    csv.end();
  });

  router.post('/reports/pdf', requireRole(...EDITORS), async (req, res) => {
    const id = await reports.requestPdf(getAuth(req), req.body, clientIp(req));
    res.status(202).json({ jobId: id });
  });

  router.get('/reports/pdf/:id', requireRole(...EDITORS), async (req, res) => {
    const { fileKey: _key, ...job } = await reports.pdfJob(getAuth(req), jobId(req));
    res.json(job);
  });

  router.get('/reports/pdf/:id/file', requireRole(...EDITORS), async (req, res) => {
    const job = await reports.pdfJob(getAuth(req), jobId(req));
    if (job.status !== 'succeeded' || !job.fileKey || !(await storage.exists(job.fileKey))) {
      throw new AppError('NOT_FOUND', 'The report is not ready');
    }
    res.type('application/pdf').attachment(job.fileName ?? 'report.pdf');
    await pipeline(storage.read(job.fileKey), res);
  });

  return router;
}
