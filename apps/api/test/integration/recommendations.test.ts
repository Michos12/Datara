import { recommendationSchema } from '@ci/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/core/ids.js';
import type { AnalyticsClient } from '../../src/infra/analytics-client.js';
import { authed, createTestContext, refreshRequest, signup, type TestSession } from './harness.js';

const fake = {
  isHealthy: async () => true,
  definitions: async () => ({ data: [] }),
  recommendationRules: async () => ({
    data: [
      {
        key: 'churn_risk_high_value',
        version: 1,
        name: 'High-value customers at risk',
        trigger: 'F ≥ 4 or M ≥ 4 …',
        action: 'Win-back offer',
        thresholds: { minCustomers: 10 },
        enabled: true,
      },
    ],
  }),
};
const ctx = createTestContext({ analytics: fake as unknown as AnalyticsClient });
let owner: TestSession;
let api: ReturnType<typeof authed>;
let org: string;
const customerIds: string[] = [];
const ids: Record<string, string> = {};

async function seed(
  key: string,
  overrides: Record<string, unknown> = {},
  customers: { id: string; value: bigint }[] = [],
) {
  const id = newId();
  await ctx.owner.recommendation.create({
    data: {
      id,
      organizationId: org,
      runId: newId(),
      ruleKey: key,
      ruleVersion: 1,
      fingerprint: `${key}:all`,
      priority: 'MEDIUM',
      priorityScore: 0.02,
      title: `${key} title`,
      opportunity: 'Opportunity',
      explanation: 'Explanation',
      suggestedAction: 'Action',
      metrics: { affectedCustomers: customers.length },
      affectedCustomers: customers.length,
      revenueAtStakeCents: 5000n,
      ...overrides,
    },
  });
  for (const c of customers) {
    await ctx.owner.recommendationCustomer.create({
      data: { recommendationId: id, customerId: c.id, organizationId: org, valueCents: c.value },
    });
  }
  ids[key] = id;
  return id;
}

beforeAll(async () => {
  owner = await signup(ctx.app);
  api = authed(ctx.app, owner.accessToken);
  org = owner.body.organization.id;
  for (const [i, name] of ['Ana', '=Ben', 'Cleo'].entries()) {
    const res = await api.post('/customers', {
      externalId: `R-${i}`,
      firstName: name,
      email: `c${i}@example.com`,
    });
    customerIds.push(res.body.id);
  }
  await seed('churn_risk_high_value', { priority: 'HIGH', priorityScore: 0.3 }, [
    { id: customerIds[0]!, value: 100n },
    { id: customerIds[1]!, value: 900n },
    { id: customerIds[2]!, value: 500n },
  ]);
  await seed('loyalty_programme', { priority: 'LOW', priorityScore: 0.001 });
  await seed('protect_champions', { status: 'DONE' });
  await seed('retention_decline', { status: 'EXPIRED' });
});
afterAll(() => ctx.close());

describe('recommendations inbox', () => {
  it('lists open and acknowledged by priority score, with filters', async () => {
    const res = await api.get('/recommendations');
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { ruleKey: string }) => r.ruleKey)).toEqual([
      'churn_risk_high_value',
      'loyalty_programme',
    ]);
    const first = recommendationSchema.parse(res.body.data[0]);
    expect(first).toMatchObject({ priority: 'high', status: 'open', revenueAtStakeCents: 5000 });
    expect(first.revenueAtStakeBasis).toContain('measured');

    const done = await api.get('/recommendations?status=done,expired');
    expect(done.body.data).toHaveLength(2);
    const high = await api.get('/recommendations?priority=high&limit=1');
    expect(high.body.data).toHaveLength(1);
    const rule = await api.get('/recommendations?ruleKey=loyalty_programme');
    expect(rule.body.data[0].ruleKey).toBe('loyalty_programme');
    expect((await api.get('/recommendations?status=closed')).status).toBe(422);
  });

  it('shows one recommendation and 404s unknown ones', async () => {
    const res = await api.get(`/recommendations/${ids.churn_risk_high_value}`);
    expect(res.body).toMatchObject({ title: 'churn_risk_high_value title', affectedCustomers: 3 });
    expect((await api.get(`/recommendations/${newId()}`)).status).toBe(404);
    expect((await api.get('/recommendations/not-a-uuid')).status).toBe(404);
  });

  it('records status changes, requires a dismissal reason and audits', async () => {
    const id = ids.loyalty_programme!;
    const noReason = await api.patch(`/recommendations/${id}`, { status: 'dismissed' });
    expect(noReason.status).toBe(422);
    const reopen = await api.patch(`/recommendations/${id}`, { status: 'open' });
    expect(reopen.status).toBe(422);
    const ack = await api.patch(`/recommendations/${id}`, { status: 'acknowledged' });
    expect(ack.body.status).toBe('acknowledged');
    const dismissed = await api.patch(`/recommendations/${id}`, {
      status: 'dismissed',
      dismissReason: 'Already running a programme',
    });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body).toMatchObject({
      status: 'dismissed',
      dismissReason: 'Already running a programme',
    });
    expect(dismissed.body.statusChangedAt).not.toBeNull();
    const row = await ctx.owner.recommendation.findUniqueOrThrow({ where: { id } });
    expect(row.statusRevenueCents).toBe(5000n);
    expect(row.statusChangedById).toBe(owner.body.user.id);
    const audit = await ctx.owner.auditLog.findMany({
      where: { organizationId: org, action: 'recommendation.status' },
    });
    expect(audit).toHaveLength(2);
    expect((await api.get('/recommendations')).body.data).toHaveLength(1);

    const expired = await api.patch(`/recommendations/${ids.retention_decline}`, {
      status: 'done',
    });
    expect(expired.status).toBe(409);
  });

  it('pages affected customers by value and exports them as CSV', async () => {
    const id = ids.churn_risk_high_value!;
    const page = await api.get(`/recommendations/${id}/customers?limit=2`);
    expect(page.status).toBe(200);
    expect(page.body.page).toEqual({ nextCursor: '2', limit: 2, total: 3 });
    expect(page.body.data.map((c: { firstName: string }) => c.firstName)).toEqual(['=Ben', 'Cleo']);
    const rest = await api.get(`/recommendations/${id}/customers?limit=2&cursor=2`);
    expect(rest.body.data.map((c: { valueCents: number }) => c.valueCents)).toEqual([100]);

    const csv = await api.get(`/recommendations/${id}/customers.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.replace(/^﻿/, '').trim().split('\n');
    expect(lines[0]).toContain('net_last_12_months_USD');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("'=Ben"); // formulas are neutralised
    expect(lines[1]).toContain('9.00');
    const audit = await ctx.owner.auditLog.count({
      where: { organizationId: org, action: 'export.recommendation_customers' },
    });
    expect(audit).toBe(1);
  });

  it('hides deleted customers from the list', async () => {
    expect((await api.delete(`/customers/${customerIds[2]}`)).status).toBe(204);
    const page = await api.get(`/recommendations/${ids.churn_risk_high_value}/customers`);
    expect(page.body.page.total).toBe(2);
  });

  it('serves the rule catalogue to owners and admins', async () => {
    const res = await api.get('/recommendations/rules');
    expect(res.status).toBe(200);
    expect(res.body.data[0].key).toBe('churn_risk_high_value');
  });

  it('lets viewers read the inbox but not customers, edits or rules', async () => {
    const session = await signup(ctx.app);
    await ctx.owner.membership.updateMany({
      where: { organizationId: session.body.organization.id },
      data: { role: 'VIEWER' },
    });
    const viewer = authed(ctx.app, (await refreshRequest(ctx.app, session)).body.accessToken);
    expect((await viewer.get('/recommendations')).status).toBe(200);
    const anyId = newId();
    expect((await viewer.get(`/recommendations/${anyId}/customers`)).status).toBe(403);
    expect((await viewer.patch(`/recommendations/${anyId}`, { status: 'done' })).status).toBe(403);
    expect((await viewer.get('/recommendations/rules')).status).toBe(403);
  });

  it('never shows another organization the recommendations', async () => {
    const outsider = authed(ctx.app, (await signup(ctx.app)).accessToken);
    expect((await outsider.get('/recommendations?status=open,done,expired')).body.data).toEqual([]);
    const id = ids.churn_risk_high_value!;
    expect((await outsider.get(`/recommendations/${id}`)).status).toBe(404);
    expect((await outsider.get(`/recommendations/${id}/customers`)).status).toBe(404);
    expect((await outsider.patch(`/recommendations/${id}`, { status: 'done' })).status).toBe(404);
  });
});
