import { customerPageSchema, customerSchema } from '@ci/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/core/ids.js';
import { authed, createTestContext, refreshRequest, signup, type TestSession } from './harness.js';

const ctx = createTestContext();
let owner: TestSession;
let api: ReturnType<typeof authed>;

beforeAll(async () => {
  owner = await signup(ctx.app, {
    organization: { name: 'Shop', timezone: 'America/Bogota', currency: 'USD', industry: 'retail' },
  });
  api = authed(ctx.app, owner.accessToken);
});
afterAll(() => ctx.close());

async function createCustomer(body: object) {
  const res = await api.post('/customers', body);
  expect(res.status).toBe(201);
  return customerSchema.parse(res.body);
}

async function createOrder(body: object) {
  const res = await api.post('/orders', body);
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body as { id: string; netCents: number };
}

describe('customers', () => {
  it('creates a customer with normalized fields and empty stats', async () => {
    const customer = await createCustomer({
      externalId: 'C-1',
      firstName: ' Ana ',
      email: 'Ana@Example.com',
      country: 'co',
      registeredAt: '2025-03-02',
      tags: ['vip'],
    });
    expect(customer).toMatchObject({
      firstName: 'Ana',
      email: 'ana@example.com',
      country: 'CO',
      registeredAt: '2025-03-02',
      stats: { orderCount: 0, totalNetCents: 0, aovCents: null, lastOrderAt: null },
    });
  });

  it('rejects duplicate external IDs and warns about duplicate emails', async () => {
    await createCustomer({ externalId: 'DUP-1', email: 'twin@example.com' });
    const dup = await api.post('/customers', { externalId: 'DUP-1' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_EXTERNAL_ID');

    const twin = await api.post('/customers', { firstName: 'Twin', email: 'twin@example.com' });
    expect(twin.status).toBe(201);
    expect(twin.headers['x-warning']).toBe('duplicate-email');
  });

  it('validates input', async () => {
    expect((await api.post('/customers', { phone: '123' })).status).toBe(422);
    expect((await api.post('/customers', { firstName: 'A', country: 'Colombia' })).status).toBe(
      422,
    );
    expect((await api.post('/customers', { firstName: 'A', isVip: true })).status).toBe(422);
  });

  it('updates, soft-deletes and restores', async () => {
    const customer = await createCustomer({ firstName: 'Temp' });
    const patched = await api.patch(`/customers/${customer.id}`, { city: 'Medellín', email: null });
    expect(patched.body).toMatchObject({ city: 'Medellín', email: null });

    expect((await api.delete(`/customers/${customer.id}`)).status).toBe(204);
    expect((await api.get(`/customers/${customer.id}`)).status).toBe(404);
    const listed = await api.get('/customers?q=Temp');
    expect(listed.body.data.map((c: { id: string }) => c.id)).not.toContain(customer.id);

    const restored = await api.post(`/customers/${customer.id}/restore`);
    expect(restored.status).toBe(200);
    expect((await api.get(`/customers/${customer.id}`)).status).toBe(200);
  });

  it('answers 404 for malformed and unknown IDs', async () => {
    expect((await api.get('/customers/not-a-uuid')).status).toBe(404);
    expect((await api.get('/customers/0193a2b4-0000-7000-8000-000000000999')).status).toBe(404);
  });

  it('increments the organization data version on writes', async () => {
    const before = await ctx.owner.organization.findUnique({
      where: { id: owner.body.organization.id },
    });
    await createCustomer({ firstName: 'Version' });
    const after = await ctx.owner.organization.findUnique({
      where: { id: owner.body.organization.id },
    });
    expect(after!.dataVersion).toBeGreaterThan(before!.dataVersion);
  });
});

describe('orders and customer statistics', () => {
  it('computes stats from countable orders only', async () => {
    const customer = await createCustomer({ externalId: 'STATS-1', firstName: 'Stats' });
    await createOrder({
      customerId: customer.id,
      orderedAt: '2026-09-01T10:00:00Z',
      grossCents: 10000,
    });
    await createOrder({
      customerId: customer.id,
      orderedAt: '2026-10-01T10:00:00Z',
      grossCents: 5000,
      discountCents: 1000,
      refundedCents: 1000,
      status: 'partially_refunded',
    });
    await createOrder({
      customerId: customer.id,
      orderedAt: '2026-10-15T10:00:00Z',
      grossCents: 9999,
      status: 'cancelled',
    });

    const res = await api.get(`/customers/${customer.id}`);
    expect(res.body.stats).toMatchObject({
      orderCount: 2,
      totalNetCents: 13000, // 10000 + (5000 - 1000 - 1000); cancelled excluded
      aovCents: 6500,
      firstOrderAt: '2026-09-01T10:00:00.000Z',
      lastOrderAt: '2026-10-01T10:00:00.000Z',
    });

    const orders = await api.get(`/customers/${customer.id}/orders`);
    expect(orders.body.data).toHaveLength(3);
    expect(orders.body.data[0].status).toBe('cancelled'); // newest first
  });

  it('computes net revenue in the database', async () => {
    const order = await createOrder({
      orderedAt: '2026-10-01T00:00:00Z',
      grossCents: 1000,
      discountCents: 100,
      taxCents: 190,
      refundedCents: 50,
    });
    expect(order.netCents).toBe(850); // tax excluded
  });

  it('accepts guest orders without a customer', async () => {
    const order = await createOrder({ orderedAt: '2026-10-01T00:00:00Z', grossCents: 500 });
    expect(order).toMatchObject({ netCents: 500 });
  });

  it.each([
    [
      'refund larger than amount paid',
      { grossCents: 1000, discountCents: 500, refundedCents: 600 },
    ],
    ['future date', { grossCents: 1000, orderedAt: '2099-01-01T00:00:00Z' }],
    ['unknown customer', { grossCents: 1000, customerId: '0193a2b4-0000-7000-8000-000000000999' }],
    ['negative amount', { grossCents: -1 }],
  ])('rejects %s', async (_label, patch) => {
    const res = await api.post('/orders', { orderedAt: '2026-10-01T00:00:00Z', ...patch });
    expect(res.status).toBe(422);
  });

  it('keeps amounts consistent on partial updates', async () => {
    const order = await createOrder({
      orderedAt: '2026-10-01T00:00:00Z',
      grossCents: 1000,
      refundedCents: 800,
    });
    const res = await api.patch(`/orders/${order.id}`, { grossCents: 500 });
    expect(res.status).toBe(422);
    const ok = await api.patch(`/orders/${order.id}`, {
      grossCents: 2000,
      status: 'partially_refunded',
    });
    expect(ok.body).toMatchObject({ netCents: 1200, status: 'partially_refunded' });
  });
});

describe('customer list', () => {
  it('sorts by spend and pages with a stable cursor', async () => {
    const session = await signup(ctx.app);
    const own = authed(ctx.app, session.accessToken);
    const spends = [3000, 1000, 5000, 0, 2000];
    const ids: string[] = [];
    for (const [i, spend] of spends.entries()) {
      const c = (await own.post('/customers', { externalId: `S-${i}`, firstName: `Spender ${i}` }))
        .body;
      ids.push(c.id);
      if (spend > 0) {
        await own.post('/orders', {
          customerId: c.id,
          orderedAt: '2026-10-01T00:00:00Z',
          grossCents: spend,
        });
      }
    }
    // Sorting and filtering by spend read the latest analytics snapshot (M9): write one, as
    // the nightly recompute would.
    const runId = newId();
    const orgId = session.body.organization.id;
    await ctx.owner.analyticsRun.create({
      data: {
        id: runId,
        organizationId: orgId,
        asOf: new Date('2026-10-02'),
        dataVersion: 0n,
        status: 'SUCCEEDED',
      },
    });
    for (const [i, spend] of spends.entries()) {
      await ctx.owner.analyticsCustomerMetrics.create({
        data: {
          runId,
          customerId: ids[i]!,
          organizationId: orgId,
          orderCount: spend > 0 ? 1 : 0,
          totalNetCents: BigInt(spend),
          lastOrderDate: spend > 0 ? new Date('2026-10-01') : null,
          lifecycleStatus: spend > 0 ? 'ACTIVE' : 'PROSPECT',
          historicalClvCents: BigInt(spend),
        },
      });
    }

    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const res = await own.get(
        `/customers?sort=-total_spent&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      const page = customerPageSchema.parse(res.body);
      seen.push(...page.data.map((c) => c.stats.totalNetCents));
      cursor = page.page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([5000, 3000, 2000, 1000, 0]);

    const filtered = await own.get('/customers?minSpentCents=2000&sort=total_spent');
    expect(
      filtered.body.data.map((c: { stats: { totalNetCents: number } }) => c.stats.totalNetCents),
    ).toEqual([2000, 3000, 5000]);
    const withoutOrders = await own.get('/customers?hasOrders=false');
    expect(withoutOrders.body.data).toHaveLength(1);
    const search = await own.get('/customers?q=spender%203');
    expect(search.body.data).toHaveLength(1);

    // Figures shown are live: an order after the snapshot shows at once.
    await own.post('/orders', {
      customerId: ids[1],
      orderedAt: '2026-10-05T00:00:00Z',
      grossCents: 700,
    });
    const live = await own.get('/customers?sort=-total_spent');
    const second = live.body.data.find((c: { id: string }) => c.id === ids[1]);
    expect(second.stats).toMatchObject({ totalNetCents: 1700, orderCount: 2 });
  });

  it('rejects tampered cursors', async () => {
    expect((await api.get('/customers?cursor=not-base64-json')).status).toBe(400);
  });
});

describe('permissions', () => {
  it('lets viewers read but not write', async () => {
    const session = await signup(ctx.app);
    await ctx.owner.membership.updateMany({
      where: { organizationId: session.body.organization.id },
      data: { role: 'VIEWER' },
    });
    const viewer = authed(ctx.app, (await refreshRequest(ctx.app, session)).body.accessToken);
    expect((await viewer.get('/customers')).status).toBe(200);
    expect((await viewer.post('/customers', { firstName: 'X' })).status).toBe(403);
    expect(
      (await viewer.post('/orders', { orderedAt: '2026-10-01T00:00:00Z', grossCents: 1 })).status,
    ).toBe(403);
  });
});
