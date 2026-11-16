import { overviewResponseSchema } from '@ci/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import type { AnalyticsClient, OverviewParams } from '../../src/infra/analytics-client.js';
import { authed, createTestContext, refreshRequest, signup, type TestSession } from './harness.js';

/** Stands in for the Python service: returns a valid overview carrying the current data version. */
class FakeAnalytics {
  calls: { organizationId: string; params: OverviewParams }[] = [];
  down = false;
  versions = new Map<string, number>();

  async isHealthy() {
    return !this.down;
  }

  async overview(organizationId: string, params: OverviewParams) {
    if (this.down)
      throw new AppError('ANALYTICS_UNAVAILABLE', 'The analytics service is not reachable');
    this.calls.push({ organizationId, params });
    return overviewResponseSchema.parse({
      meta: {
        metric: 'overview',
        definitionVersions: { revenue_net: 1 },
        kind: 'measured',
        period: {
          start: params.start ?? '2026-10-01',
          end: params.end ?? '2026-11-01',
          grain: 'day',
        },
        comparePeriod: null,
        asOf: '2026-10-31',
        today: '2026-11-16',
        timezone: 'UTC',
        currency: 'USD',
        settings: {},
        computedAt: new Date().toISOString(),
        dataVersion: this.versions.get(organizationId) ?? 0,
        warnings: [],
      },
      data: {
        kpis: [
          {
            key: 'revenue_net',
            value: 100,
            previous: null,
            change: null,
            changeType: 'relative',
            unit: 'money',
            kind: 'measured',
          },
        ],
        trend: [],
        guestRevenueShare: null,
        historicalClvMedian: null,
      },
    });
  }

  async definitions() {
    return { data: [] };
  }
}

const fake = new FakeAnalytics();
const ctx = createTestContext({ analytics: fake as unknown as AnalyticsClient });
let owner: TestSession;
let api: ReturnType<typeof authed>;

async function syncVersion(session: TestSession) {
  const org = await ctx.owner.organization.findUnique({
    where: { id: session.body.organization.id },
  });
  fake.versions.set(session.body.organization.id, Number(org!.dataVersion));
}

async function pendingRecomputes(organizationId: string) {
  return ctx.owner.job.findMany({
    where: { organizationId, type: 'analytics.recompute', status: 'PENDING' },
  });
}

beforeAll(async () => {
  owner = await signup(ctx.app);
  api = authed(ctx.app, owner.accessToken);
});
afterAll(() => ctx.close());

describe('GET /analytics/overview', () => {
  it('caches results until the organization data changes', async () => {
    await syncVersion(owner);
    const q = '/analytics/overview?start=2026-10-01&end=2026-11-01';
    const first = await api.get(q);
    expect(first.status).toBe(200);
    expect(first.body.meta.cached).toBe(false);
    const second = await api.get(q);
    expect(second.body.meta.cached).toBe(true);
    expect(fake.calls.filter((c) => c.organizationId === owner.body.organization.id)).toHaveLength(
      1,
    );

    await api.post('/customers', { firstName: 'Changes the data' });
    await syncVersion(owner);
    const third = await api.get(q);
    expect(third.body.meta.cached).toBe(false);
    expect(fake.calls.filter((c) => c.organizationId === owner.body.organization.id)).toHaveLength(
      2,
    );
  });

  it('caches each parameter set separately', async () => {
    const before = fake.calls.length;
    await api.get('/analytics/overview?start=2026-09-01&end=2026-10-01&compare=previous_year');
    await api.get('/analytics/overview?start=2026-09-01&end=2026-10-01&compare=none');
    expect(fake.calls.length - before).toBe(2);
    expect(fake.calls.at(-1)!.params).toMatchObject({ compare: 'none' });
  });

  it('validates the query', async () => {
    expect((await api.get('/analytics/overview?start=2026-10-01')).status).toBe(422);
    expect((await api.get('/analytics/overview?start=2026-10-05&end=2026-10-01')).status).toBe(422);
    expect((await api.get('/analytics/overview?grain=hour')).status).toBe(422);
  });

  it('reports 503 when the analytics service is down', async () => {
    fake.down = true;
    try {
      const res = await api.get('/analytics/overview?start=2026-01-01&end=2026-02-01');
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('ANALYTICS_UNAVAILABLE');
    } finally {
      fake.down = false;
    }
  });
});

describe('recompute scheduling', () => {
  it('debounces edits into one pending recompute about ten minutes out', async () => {
    const session = await signup(ctx.app);
    const own = authed(ctx.app, session.accessToken);
    const org = session.body.organization.id;
    await own.post('/customers', { firstName: 'One' });
    await own.post('/customers', { firstName: 'Two' });
    const pending = await pendingRecomputes(org);
    expect(pending).toHaveLength(1);
    const delay = pending[0]!.runAfter.getTime() - Date.now();
    expect(delay).toBeGreaterThan(8 * 60_000);
    expect(delay).toBeLessThan(11 * 60_000);

    // "Recompute now" moves the same job forward instead of adding another.
    const res = await own.post('/analytics/runs');
    expect(res.status).toBe(202);
    const after = await pendingRecomputes(org);
    expect(after).toHaveLength(1);
    expect(after[0]!.runAfter.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(res.body).toMatchObject({ latestRun: null, stale: true });
    expect(res.body.pending).not.toBeNull();
  });

  it('recomputes immediately when thresholds or the time zone change', async () => {
    const session = await signup(ctx.app);
    await authed(ctx.app, session.accessToken).patch('/organization', {
      timezone: 'Europe/Madrid',
    });
    const pending = await pendingRecomputes(session.body.organization.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.runAfter.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('lets viewers read status but not trigger runs', async () => {
    const session = await signup(ctx.app);
    await ctx.owner.membership.updateMany({
      where: { organizationId: session.body.organization.id },
      data: { role: 'VIEWER' },
    });
    const viewer = authed(ctx.app, (await refreshRequest(ctx.app, session)).body.accessToken);
    expect((await viewer.get('/analytics/status')).status).toBe(200);
    expect((await viewer.post('/analytics/runs')).status).toBe(403);
  });
});

describe('GET /exports/customers.csv', () => {
  it('streams customers with stats, neutralizes formulas and audits the export', async () => {
    const session = await signup(ctx.app, {
      organization: { name: 'Exporter', timezone: 'UTC', currency: 'USD', industry: 'retail' },
    });
    const own = authed(ctx.app, session.accessToken);
    const c = (
      await own.post('/customers', {
        externalId: 'X-1',
        firstName: '=HYPERLINK("http://evil")',
        email: 'x@example.com',
      })
    ).body;
    await own.post('/orders', {
      customerId: c.id,
      orderedAt: '2026-10-01T00:00:00Z',
      grossCents: 12345,
    });
    await own.post('/customers', { externalId: 'X-2', firstName: 'Plain' });

    const res = await own.get('/exports/customers.csv?sort=name');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="?customers-\d{4}-\d{2}-\d{2}\.csv/,
    );
    const lines = res.text
      .replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), '')
      .trim()
      .split('\n');
    expect(lines[0]).toContain('externalId,firstName,lastName,email');
    expect(lines).toHaveLength(3);
    const evil = lines.find((l) => l.startsWith('X-1'))!;
    expect(evil).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(evil).toContain('123.45');

    const audit = await own.get('/organization/audit-logs?limit=1');
    expect(audit.body.data[0]).toMatchObject({ action: 'export.customers', details: { rows: 2 } });
  });

  it('is not available to viewers', async () => {
    const session = await signup(ctx.app);
    await ctx.owner.membership.updateMany({
      where: { organizationId: session.body.organization.id },
      data: { role: 'VIEWER' },
    });
    const viewer = authed(ctx.app, (await refreshRequest(ctx.app, session)).body.accessToken);
    expect((await viewer.get('/exports/customers.csv')).status).toBe(403);
  });

  it("never includes another organization's customers", async () => {
    const other = await signup(ctx.app);
    await authed(ctx.app, other.accessToken).post('/customers', { externalId: 'SECRET-1' });
    const res = await api.get('/exports/customers.csv');
    expect(res.text).not.toContain('SECRET-1');
  });
});
