import { comparisonResponseSchema } from '@ci/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyticsClient } from '../../src/infra/analytics-client.js';
import { authed, createTestContext, refreshRequest, signup, type TestSession } from './harness.js';

function meta(metric: string, start: string, end: string, version: number) {
  return {
    metric,
    definitionVersions: {},
    kind: 'measured',
    period: { start, end, grain: 'month' },
    comparePeriod: null,
    asOf: end,
    today: '2026-11-17',
    timezone: 'UTC',
    currency: 'USD',
    settings: {},
    computedAt: new Date().toISOString(),
    dataVersion: version,
    warnings: [],
  };
}

const kpi = (key: string, unit: string, value: number | null) => ({
  key,
  value,
  previous: null,
  change: null,
  changeType: unit === 'ratio' ? 'points' : 'relative',
  unit,
  kind: 'measured',
});

/** Revenue and retention depend on the period, so the comparison has something to compare. */
class FakeAnalytics {
  version = 0;
  overviewCalls: Record<string, unknown>[] = [];
  async isHealthy() {
    return true;
  }
  async definitions() {
    return {
      data: [
        {
          key: 'revenue_net',
          name: 'Net revenue',
          version: 1,
          kind: 'measured',
          unit: 'money',
          formula: '',
          period_rule: '',
          description: '',
        },
      ],
    };
  }
  async recommendationRules() {
    return { data: [] };
  }
  async overview(_org: string, params: { start: string; end: string; segment?: string }) {
    this.overviewCalls.push(params);
    const january = params.start === '2026-01-01';
    return {
      meta: meta('overview', params.start, params.end, this.version),
      data: {
        kpis: [
          kpi('revenue_net', 'money', january ? 100_000 : 125_050),
          kpi('orders', 'count', january ? 40 : 40),
          kpi('retention_rate', 'ratio', january ? 0.3 : 0.25),
          kpi('aov', 'money', january ? 0 : 3126),
        ],
        trend: [
          {
            period: params.start,
            end: params.end,
            revenueNet: 100_000,
            orders: 40,
            aov: 2500,
            buyers: 30,
            newCustomers: 10,
            returningCustomers: 20,
            partial: false,
          },
        ],
        guestRevenueShare: 0,
        historicalClvMedian: null,
      },
    };
  }
  async behavior(kind: string, _org: string, params: Record<string, unknown>) {
    if (kind === 'retention') {
      return {
        meta: meta('retention_rate', '2026-01-01', '2026-03-01', this.version),
        data: {
          series: [
            {
              period: '2026-01-01',
              end: '2026-02-01',
              partial: false,
              base: 120,
              retained: 36,
              rate: 0.3,
              low: 0.22,
              high: 0.39,
              lowSample: false,
            },
          ],
          recommendedGrain: { grain: 'month', medianGapDays: 20 },
        },
      };
    }
    if (kind === 'cohorts') {
      return {
        meta: meta('cohort_retention', '2026-01-01', '2026-03-01', this.version),
        data: {
          periods: [0, 1],
          cohorts: [
            {
              cohort: '2026-01',
              size: 10,
              lowSample: true,
              active: [10, null],
              retention: [1, null],
              revenuePerCustomer: [1234, null],
              cumulativeRevenuePerCustomer: [1234, null],
            },
          ],
          average: {
            size: 10,
            retention: [1, null],
            revenuePerCustomer: [1234, null],
            cumulativeRevenuePerCustomer: [1234, null],
          },
        },
      };
    }
    throw new Error(`unexpected ${kind} ${JSON.stringify(params)}`);
  }
}

const fake = new FakeAnalytics();
const ctx = createTestContext({ analytics: fake as unknown as AnalyticsClient });
let owner: TestSession;
let api: ReturnType<typeof authed>;
let org: string;

const lines = (text: string) =>
  text
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n');

beforeAll(async () => {
  owner = await signup(ctx.app, {
    organization: { name: 'Report Shop', timezone: 'UTC', currency: 'USD', industry: 'retail' },
  });
  api = authed(ctx.app, owner.accessToken);
  org = owner.body.organization.id;
});
afterAll(() => ctx.close());

describe('period comparison', () => {
  const query = 'aStart=2026-01-01&aEnd=2026-02-01&bStart=2026-02-01&bEnd=2026-03-01';

  it('puts two periods side by side with absolute and relative change', async () => {
    const res = await api.get(`/reports/comparison?${query}`);
    expect(res.status).toBe(200);
    const body = comparisonResponseSchema.parse(res.body);
    const byKey = Object.fromEntries(body.rows.map((r) => [r.key, r]));
    expect(byKey.revenue_net).toMatchObject({ a: 100_000, b: 125_050, difference: 25_050 });
    expect(byKey.revenue_net!.relativeChange).toBeCloseTo(0.2505);
    expect(byKey.orders).toMatchObject({ difference: 0, relativeChange: 0 });
    // Ratios change in points, not percent; division by zero gives no relative change.
    expect(byKey.retention_rate!.difference).toBeCloseTo(-0.05);
    expect(byKey.retention_rate!.relativeChange).toBeNull();
    expect(byKey.aov!.relativeChange).toBeNull();
    expect(fake.overviewCalls.every((c) => c.compare === 'none')).toBe(true);
  });

  it('exports the comparison as CSV in major units', async () => {
    const res = await api.get(`/exports/comparison.csv?${query}`);
    expect(res.status).toBe(200);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const rows = lines(res.text);
    expect(rows[0]).toBe('kpi,unit,period_a,period_b,difference,relative_change');
    expect(rows[1]).toBe('revenue_net,money_USD,1000,1250.5,250.5,0.2505');
  });

  it('validates periods and needs a snapshot for a segment', async () => {
    const bad = await api.get(
      '/reports/comparison?aStart=2026-02-01&aEnd=2026-01-01&bStart=2026-02-01&bEnd=2026-03-01',
    );
    expect(bad.status).toBe(422);
    expect((await api.get(`/reports/comparison?${query}&segment=champions`)).status).toBe(409);
  });
});

describe('CSV exports', () => {
  it('exports KPIs with names and the data behind charts', async () => {
    const kpis = await api.get('/exports/kpis.csv?start=2026-01-01&end=2026-02-01');
    expect(kpis.status).toBe(200);
    const rows = lines(kpis.text);
    expect(rows[0]).toBe('kpi,name,unit,value,previous,change,change_type,kind');
    expect(rows[1]).toContain('revenue_net,Net revenue,money_USD,1000,');

    const overview = await api.get(
      '/exports/analytics/overview.csv?start=2026-01-01&end=2026-02-01',
    );
    expect(lines(overview.text)[1]).toBe('2026-01-01,2026-02-01,1000,40,25,30,10,20,false');

    const retention = await api.get('/exports/analytics/retention.csv?grain=month');
    expect(lines(retention.text)[1]).toContain('120,36,0.3');

    const cohorts = await api.get('/exports/analytics/cohorts.csv');
    const cohortRows = lines(cohorts.text);
    expect(cohortRows[1]).toBe('2026-01,10,0,10,1,12.34,12.34');
    expect(cohortRows[2]).toBe('2026-01,10,1,,,,'); // months not over yet stay empty, never 0

    expect((await api.get('/exports/analytics/nope.csv')).status).toBe(404);
    expect((await api.get('/exports/analytics/retention.csv?grain=day')).status).toBe(422);
  });

  it('streams orders with neutralised cells and audits the export', async () => {
    const customer = await api.post('/customers', { externalId: 'C-1', firstName: 'Ana' });
    await api.post('/orders', {
      customerId: customer.body.id,
      externalId: '=1+1',
      orderedAt: '2026-01-05T10:00:00Z',
      grossCents: 12_345,
      discountCents: 345,
    });
    const res = await api.get('/exports/orders.csv');
    expect(res.status).toBe(200);
    const rows = lines(res.text);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain(`'=1+1,${customer.body.id}`);
    expect(rows[1]).toContain('123.45,3.45,0.00,0.00,120.00');
    const audits = await ctx.owner.auditLog.count({
      where: { organizationId: org, action: 'export.orders' },
    });
    expect(audits).toBe(1);

    const session = await signup(ctx.app);
    await ctx.owner.membership.updateMany({
      where: { organizationId: session.body.organization.id },
      data: { role: 'VIEWER' },
    });
    const viewer = authed(ctx.app, (await refreshRequest(ctx.app, session)).body.accessToken);
    expect((await viewer.get('/exports/orders.csv')).status).toBe(403);
    expect((await viewer.get('/exports/kpis.csv?start=2026-01-01&end=2026-02-01')).status).toBe(
      200,
    );
  });
});

describe('PDF report', () => {
  it('runs as a job and produces a downloadable PDF', async () => {
    const queued = await api.post('/reports/pdf', { start: '2026-01-01', end: '2026-03-01' });
    expect(queued.status).toBe(202);
    const id = queued.body.jobId as string;
    expect((await api.get(`/reports/pdf/${id}`)).body.status).toBe('pending');
    expect((await api.get(`/reports/pdf/${id}/file`)).status).toBe(404);

    await ctx.runJobs(['report.']);
    const done = await api.get(`/reports/pdf/${id}`);
    expect(done.body).toMatchObject({
      status: 'succeeded',
      fileName: 'customer-insights-2026-01-01-2026-03-01.pdf',
      error: null,
    });
    const file = await api
      .get(`/reports/pdf/${id}/file`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    const body = file.body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(body.length).toBeGreaterThan(1000);
  });

  it('validates the request and hides other organizations’ reports', async () => {
    expect(
      (await api.post('/reports/pdf', { start: '2026-03-01', end: '2026-01-01' })).status,
    ).toBe(422);
    expect(
      (await api.post('/reports/pdf', { start: '2026-01-01', end: '2026-02-01', sections: [] }))
        .status,
    ).toBe(422);
    const queued = await api.post('/reports/pdf', { start: '2026-01-01', end: '2026-02-01' });
    const outsider = authed(ctx.app, (await signup(ctx.app)).accessToken);
    expect((await outsider.get(`/reports/pdf/${queued.body.jobId}`)).status).toBe(404);
  });
});
