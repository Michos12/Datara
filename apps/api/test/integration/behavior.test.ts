import { DEFAULT_SEGMENT_CONFIG } from '@ci/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/core/ids.js';
import type { AnalyticsClient } from '../../src/infra/analytics-client.js';
import { authed, createTestContext, refreshRequest, signup, type TestSession } from './harness.js';

function meta(metric: string, dataVersion = 0) {
  return {
    metric,
    definitionVersions: {},
    kind: 'measured',
    period: { start: '2026-01-01', end: '2026-04-01', grain: 'month' },
    comparePeriod: null,
    asOf: '2026-03-31',
    today: '2026-11-16',
    timezone: 'UTC',
    currency: 'USD',
    settings: {},
    computedAt: new Date().toISOString(),
    dataVersion,
    warnings: [],
  };
}

const rate = { rate: 0.5, low: 0.1, high: 0.9, lowSample: true };
const grain = { grain: 'month', medianGapDays: 20 };

class FakeAnalytics {
  calls: { kind: string; params: Record<string, unknown> }[] = [];
  churned: { customerId: string; netCents: number }[] = [];
  /** The data version the real service would read (it answers with the organization's). */
  version = 0;
  async isHealthy() {
    return true;
  }
  async definitions() {
    return { data: [] };
  }
  async behavior(kind: string, _org: string, params: Record<string, unknown>) {
    this.calls.push({ kind, params });
    switch (kind) {
      case 'retention':
        return {
          meta: meta('retention_rate'),
          data: {
            series: [
              {
                period: '2026-01-01',
                end: '2026-02-01',
                partial: false,
                base: 2,
                retained: 1,
                ...rate,
              },
            ],
            recommendedGrain: grain,
          },
        };
      case 'churn':
        return {
          meta: meta('churn_rate'),
          data: {
            series: [
              {
                period: '2026-01-01',
                end: '2026-02-01',
                partial: false,
                base: 2,
                churned: 1,
                reactivated: 0,
                ...rate,
              },
            ],
            bySegment: [{ segment: 'champions', base: 2, churned: 1, ...rate }],
            segmentAsOf: '2025-12-31',
            totals: { churned: 1, reactivated: 0 },
            churnDays: 180,
            recommendedGrain: grain,
          },
        };
      case 'churn/customers':
        return {
          meta: meta('churn_rate', this.version),
          data: this.churned.map((c) => ({
            customerId: c.customerId,
            lastPurchase: '2025-07-01',
            churnDate: '2025-12-28',
            orders: 2,
            netCents: c.netCents,
          })),
        };
      case 'cohorts':
        return {
          meta: meta('cohort_retention'),
          data: {
            periods: [0, 1],
            cohorts: [
              {
                cohort: '2026-01',
                size: 2,
                lowSample: true,
                active: [2, 1],
                retention: [1, 0.5],
                revenuePerCustomer: [100, 50],
                cumulativeRevenuePerCustomer: [100, 150],
              },
            ],
            average: {
              size: 2,
              retention: [1, 0.5],
              revenuePerCustomer: [100, 50],
              cumulativeRevenuePerCustomer: [100, 150],
            },
          },
        };
    }
    throw new Error(`unexpected ${kind}`);
  }
}

const fake = new FakeAnalytics();
const ctx = createTestContext({ analytics: fake as unknown as AnalyticsClient });
let owner: TestSession;
let api: ReturnType<typeof authed>;
let org: string;

beforeAll(async () => {
  owner = await signup(ctx.app);
  api = authed(ctx.app, owner.accessToken);
  org = owner.body.organization.id;
});
afterAll(() => ctx.close());

describe('retention, churn and cohorts', () => {
  it('serves retention through the query cache', async () => {
    const first = await api.get('/analytics/retention?grain=month');
    expect(first.status).toBe(200);
    expect(first.body.data.series[0]).toMatchObject({ retained: 1, base: 2, rate: 0.5 });
    expect(first.body.meta.cached).toBe(false);
    const again = await api.get('/analytics/retention?grain=month');
    expect(again.body.meta.cached).toBe(true);
    expect(fake.calls.filter((c) => c.kind === 'retention')).toHaveLength(1);
  });

  it('validates parameters', async () => {
    expect((await api.get('/analytics/retention?grain=day')).status).toBe(422);
    expect((await api.get('/analytics/retention?start=2026-01-01')).status).toBe(422);
    expect((await api.get('/analytics/cohorts?maxPeriods=99')).status).toBe(422);
    expect((await api.get('/analytics/churn/customers?cursor=abc')).status).toBe(422);
  });

  it('sends the active segment configuration with churn queries', async () => {
    const res = await api.get('/analytics/churn?start=2026-01-01&end=2026-04-01');
    expect(res.status).toBe(200);
    expect(res.body.data.bySegment[0]).toMatchObject({ segment: 'champions', churned: 1 });
    const call = fake.calls.find((c) => c.kind === 'churn')!;
    expect(call.params).toMatchObject({
      start: '2026-01-01',
      end: '2026-04-01',
      segmentConfig: DEFAULT_SEGMENT_CONFIG,
    });
  });

  it('passes cohort options through', async () => {
    const res = await api.get('/analytics/cohorts?maxPeriods=6');
    expect(res.status).toBe(200);
    expect(res.body.data.cohorts[0].retention).toEqual([1, 0.5]);
    expect(fake.calls.find((c) => c.kind === 'cohorts')!.params).toMatchObject({ maxPeriods: 6 });
  });

  it('needs a snapshot before filtering by segment', async () => {
    const res = await api.get('/analytics/cohorts?segment=champions');
    expect(res.status).toBe(409);
  });
});

describe('GET /analytics/churn/customers', () => {
  it('pages churned customers with their details and latest segment', async () => {
    const ids: string[] = [];
    for (const [i, name] of ['Ana', 'Ben', 'Cleo'].entries()) {
      const res = await api.post('/customers', {
        externalId: `CH-${i}`,
        firstName: name,
        email: `${name.toLowerCase()}@example.com`,
      });
      ids.push(res.body.id);
    }
    const runId = newId();
    await ctx.owner.analyticsRun.create({
      data: {
        id: runId,
        organizationId: org,
        asOf: new Date('2026-11-16'),
        dataVersion: 0n,
        status: 'SUCCEEDED',
      },
    });
    await ctx.owner.analyticsCustomerMetrics.create({
      data: {
        runId,
        customerId: ids[1]!,
        organizationId: org,
        orderCount: 2,
        totalNetCents: 900n,
        lifecycleStatus: 'CHURNED',
        historicalClvCents: 900n,
        segmentKey: 'lost',
      },
    });
    const current = await ctx.owner.organization.findUniqueOrThrow({ where: { id: org } });
    fake.version = Number(current.dataVersion);
    fake.churned = [
      { customerId: ids[1]!, netCents: 900 },
      { customerId: ids[0]!, netCents: 500 },
      { customerId: ids[2]!, netCents: 100 },
    ];

    const first = await api.get(
      '/analytics/churn/customers?start=2025-12-01&end=2026-01-01&limit=2',
    );
    expect(first.status).toBe(200);
    expect(first.body.page).toEqual({ nextCursor: '2', limit: 2, total: 3 });
    expect(first.body.data).toMatchObject([
      {
        customerId: ids[1],
        firstName: 'Ben',
        email: 'ben@example.com',
        segment: 'lost',
        netCents: 900,
      },
      { customerId: ids[0], firstName: 'Ana', segment: null },
    ]);

    const second = await api.get(
      '/analytics/churn/customers?start=2025-12-01&end=2026-01-01&limit=2&cursor=2',
    );
    expect(second.body.data.map((c: { firstName: string }) => c.firstName)).toEqual(['Cleo']);
    expect(second.body.page.nextCursor).toBeNull();
    // Both pages came from one analytics call (the full list is cached).
    expect(fake.calls.filter((c) => c.kind === 'churn/customers')).toHaveLength(1);
  });

  it('is not available to viewers, while the charts are', async () => {
    const session = await signup(ctx.app);
    await ctx.owner.membership.updateMany({
      where: { organizationId: session.body.organization.id },
      data: { role: 'VIEWER' },
    });
    const viewer = authed(ctx.app, (await refreshRequest(ctx.app, session)).body.accessToken);
    expect((await viewer.get('/analytics/churn/customers')).status).toBe(403);
    expect((await viewer.get('/analytics/cohorts')).status).toBe(200);
  });

  it('never shows another organization its customers', async () => {
    const other = await signup(ctx.app);
    const outsider = authed(ctx.app, other.accessToken);
    // The fake returns this organization's IDs; row-level security hides their details.
    const res = await outsider.get('/analytics/churn/customers?start=2025-12-01&end=2026-01-01');
    expect(res.status).toBe(200);
    expect(res.body.data.every((c: { email: string | null }) => c.email === null)).toBe(true);
  });
});
