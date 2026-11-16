import { DEFAULT_SEGMENT_CONFIG, overviewResponseSchema } from '@ci/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/core/ids.js';
import type { AnalyticsClient, OverviewParams } from '../../src/infra/analytics-client.js';
import { authed, createTestContext, refreshRequest, signup, type TestSession } from './harness.js';

class FakeAnalytics {
  previews: unknown[] = [];
  overviews: OverviewParams[] = [];
  async isHealthy() {
    return true;
  }
  async segmentPreview(_org: string, config: unknown) {
    this.previews.push(config);
    return {
      asOf: '2026-11-16',
      counts: { champions: 3 },
      noPurchases: 1,
      matrix: Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]),
    };
  }
  async overview(_org: string, params: OverviewParams) {
    this.overviews.push(params);
    return overviewResponseSchema.parse({
      meta: {
        metric: 'overview',
        definitionVersions: {},
        kind: 'measured',
        period: { start: '2026-10-01', end: '2026-11-01', grain: 'day' },
        comparePeriod: null,
        asOf: '2026-10-31',
        today: '2026-11-16',
        timezone: 'UTC',
        currency: 'USD',
        settings: {},
        computedAt: new Date().toISOString(),
        dataVersion: 0,
        warnings: [],
      },
      data: { kpis: [], trend: [], guestRevenueShare: null, historicalClvMedian: null },
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
let org: string;

/** Inserts a succeeded snapshot like the Python worker would. */
async function seedRun(
  organizationId: string,
  rows: {
    customerId: string;
    segment: string | null;
    r: number | null;
    f: number | null;
    m: number | null;
    spend: number;
  }[],
) {
  const runId = newId();
  await ctx.owner.analyticsRun.create({
    data: {
      id: runId,
      organizationId,
      asOf: new Date('2026-11-16'),
      dataVersion: 0n,
      status: 'SUCCEEDED',
      segmentConfigVersion: 1,
    },
  });
  for (const row of rows) {
    await ctx.owner.analyticsCustomerMetrics.create({
      data: {
        runId,
        customerId: row.customerId,
        organizationId,
        orderCount: row.f ?? 0,
        totalNetCents: BigInt(row.spend),
        lifecycleStatus: row.segment ? 'ACTIVE' : 'PROSPECT',
        historicalClvCents: BigInt(row.spend),
        recencyDays: row.segment ? 10 : null,
        fValue: row.f,
        mValueCents: row.segment ? BigInt(row.spend) : null,
        rScore: row.r,
        fScore: row.f === null ? null : Math.min(row.f, 5),
        mScore: row.m,
        segmentKey: row.segment,
      },
    });
  }
  return runId;
}

beforeAll(async () => {
  owner = await signup(ctx.app);
  api = authed(ctx.app, owner.accessToken);
  org = owner.body.organization.id;
});
afterAll(() => ctx.close());

describe('segment configuration', () => {
  it('seeds the default configuration as active version 1 at signup', async () => {
    const res = await api.get('/segments/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 1, isActive: true, config: DEFAULT_SEGMENT_CONFIG });
  });

  it('saves validated versions, activates them and schedules a recompute', async () => {
    const session = await signup(ctx.app);
    const own = authed(ctx.app, session.accessToken);
    const changed = { ...DEFAULT_SEGMENT_CONFIG, lookbackDays: 180 };
    const saved = await own.post('/segments/config', { config: changed });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ version: 2, isActive: true, config: { lookbackDays: 180 } });

    const versions = await own.get('/segments/config/versions');
    expect(
      versions.body.data.map((v: { version: number; isActive: boolean }) => [
        v.version,
        v.isActive,
      ]),
    ).toEqual([
      [2, true],
      [1, false],
    ]);
    const jobs = await ctx.owner.job.findMany({
      where: {
        organizationId: session.body.organization.id,
        type: 'analytics.recompute',
        status: 'PENDING',
      },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.runAfter.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const back = await own.post('/segments/config/1/activate');
    expect(back.body).toMatchObject({ version: 1, isActive: true });
    expect((await own.get('/segments/config')).body.version).toBe(1);
  });

  it('rejects configurations that leave customers without a segment', async () => {
    const res = await api.post('/segments/config', {
      config: { ...DEFAULT_SEGMENT_CONFIG, rules: DEFAULT_SEGMENT_CONFIG.rules.slice(0, 3) },
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.errors)).toMatch(/needs a segment/);
  });

  it('validates previews before calling the analytics service', async () => {
    const before = fake.previews.length;
    expect(
      (await api.post('/segments/config/preview', { config: { lookbackDays: 1 } })).status,
    ).toBe(422);
    expect(fake.previews.length).toBe(before);
    const ok = await api.post('/segments/config/preview', { config: DEFAULT_SEGMENT_CONFIG });
    expect(ok.status).toBe(200);
    expect(ok.body.counts).toEqual({ champions: 3 });
  });

  it('lets viewers read segments but not change them', async () => {
    const session = await signup(ctx.app);
    await ctx.owner.membership.updateMany({
      where: { organizationId: session.body.organization.id },
      data: { role: 'VIEWER' },
    });
    const viewer = authed(ctx.app, (await refreshRequest(ctx.app, session)).body.accessToken);
    expect((await viewer.get('/segments')).status).toBe(200);
    expect((await viewer.get('/segments/config')).status).toBe(200);
    expect((await viewer.post('/segments/config', { config: DEFAULT_SEGMENT_CONFIG })).status).toBe(
      403,
    );
    expect(
      (await viewer.post('/segments/config/preview', { config: DEFAULT_SEGMENT_CONFIG })).status,
    ).toBe(403);
  });
});

describe('segment summary and filters', () => {
  it('is empty before the first snapshot, and the segment overview filter needs one', async () => {
    const res = await api.get('/segments');
    expect(res.body).toMatchObject({ run: null, segments: [], noPurchases: 0 });
    expect((await api.get('/analytics/overview?segment=champions')).status).toBe(409);
  });

  it('summarizes the latest snapshot and filters customers by segment', async () => {
    const ids: Record<string, string> = {};
    for (const name of ['champ1', 'champ2', 'lost1', 'prospect']) {
      ids[name] = (await api.post('/customers', { externalId: name, firstName: name })).body.id;
    }
    const runId = await seedRun(org, [
      { customerId: ids.champ1!, segment: 'champions', r: 5, f: 5, m: 5, spend: 9000 },
      { customerId: ids.champ2!, segment: 'champions', r: 4, f: 4, m: 4, spend: 6000 },
      { customerId: ids.lost1!, segment: 'lost', r: 1, f: 1, m: 1, spend: 1000 },
      { customerId: ids.prospect!, segment: null, r: null, f: null, m: null, spend: 0 },
    ]);

    const summary = (await api.get('/segments')).body;
    expect(summary.run).toMatchObject({ id: runId, configVersion: 1 });
    expect(summary.noPurchases).toBe(1);
    const champions = summary.segments.find((s: { key: string }) => s.key === 'champions');
    expect(champions).toMatchObject({ name: 'Champions', customers: 2, avgSpendCents: 7500 });
    expect(champions.customerShare).toBeCloseTo(2 / 3);
    expect(champions.revenueShare).toBeCloseTo(15000 / 16000);
    expect(summary.segments).toHaveLength(DEFAULT_SEGMENT_CONFIG.rules.length);
    expect(summary.matrix[4][4]).toBe(1); // R5 F5
    expect(summary.matrix[0][0]).toBe(1); // R1 F1

    const filtered = await api.get('/customers?segment=champions&sort=name');
    expect(filtered.body.data.map((c: { externalId: string }) => c.externalId)).toEqual([
      'champ1',
      'champ2',
    ]);
    expect(filtered.body.data[0].segment).toMatchObject({
      key: 'champions',
      rScore: 5,
      fScore: 5,
      mScore: 5,
    });
    const prospects = await api.get('/customers?segment=no_purchases');
    expect(prospects.body.data.map((c: { externalId: string }) => c.externalId)).toEqual([
      'prospect',
    ]);

    // A customer created after the snapshot has no segment yet.
    const fresh = (await api.post('/customers', { firstName: 'After snapshot' })).body;
    expect(fresh.segment).toBeNull();

    // The overview segment filter passes the snapshot it is based on to the analytics service.
    const overview = await api.get('/analytics/overview?segment=champions');
    expect(overview.status).toBe(200);
    expect(fake.overviews.at(-1)).toMatchObject({ segment: 'champions', runId });
  });

  it('keeps segment configurations tenant-isolated', async () => {
    const other = await signup(ctx.app);
    await ctx.db.run({ organizationId: org }, async (tx) => {
      const visible = await tx.segmentConfig.findMany();
      expect(visible.every((c) => c.organizationId === org)).toBe(true);
      expect(
        await tx.segmentConfig.count({ where: { organizationId: other.body.organization.id } }),
      ).toBe(0);
    });
  });
});
