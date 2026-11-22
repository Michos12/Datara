import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup } from '../../src/modules/maintenance/maintenance.jobs.js';
import { authed, createTestContext, refreshRequest, signup, type TestSession } from './harness.js';

const ctx = createTestContext();
let owner: TestSession;
let api: ReturnType<typeof authed>;
let org: string;

/** Reads the entries of a ZIP produced by infra/zip.ts (deflate, sizes in the central directory). */
function unzip(buffer: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  const end = buffer.length - 22;
  expect(buffer.readUInt32LE(end)).toBe(0x06054b50);
  let central = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    const compressed = buffer.readUInt32LE(central + 20);
    const nameLength = buffer.readUInt16LE(central + 28);
    const skip = nameLength + buffer.readUInt16LE(central + 30) + buffer.readUInt16LE(central + 32);
    const name = buffer.subarray(central + 46, central + 46 + nameLength).toString('utf8');
    const local = buffer.readUInt32LE(central + 42);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    files.set(name, inflateRawSync(buffer.subarray(start, start + compressed)).toString('utf8'));
    central += 46 + skip;
  }
  return files;
}

beforeAll(async () => {
  owner = await signup(ctx.app, {
    organization: { name: 'Privacy Shop', timezone: 'UTC', currency: 'USD', industry: 'retail' },
  });
  api = authed(ctx.app, owner.accessToken);
  org = owner.body.organization.id;
});
afterAll(() => ctx.close());

async function customerWithHistory(name: string) {
  const c = await api.post('/customers', {
    externalId: `P-${name}`,
    firstName: name,
    email: `${name.toLowerCase()}@example.com`,
    phone: '+57 300 000 0000',
    tags: ['vip'],
  });
  await api.post('/orders', {
    customerId: c.body.id,
    orderedAt: '2026-10-01T10:00:00Z',
    grossCents: 10_000,
  });
  await api.post('/interactions', {
    customerId: c.body.id,
    type: 'review',
    occurredAt: '2026-10-02T10:00:00Z',
    metadata: { text: 'Loved it' },
  });
  return c.body.id as string;
}

describe('right to erasure', () => {
  it('anonymizes a customer but keeps their orders for aggregates', async () => {
    const id = await customerWithHistory('Ana');
    const res = await api.post(`/customers/${id}/erase`, { mode: 'anonymize' });
    expect(res.status).toBe(204);
    const row = await ctx.owner.customer.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      firstName: null,
      email: null,
      phone: null,
      externalId: null,
      tags: [],
      marketingConsent: false,
    });
    expect(row.anonymizedAt).not.toBeNull();
    expect(await ctx.owner.order.count({ where: { customerId: id } })).toBe(1);
    const interaction = await ctx.owner.interaction.findFirstOrThrow({ where: { customerId: id } });
    expect(interaction.metadata).toEqual({});
    const audit = await ctx.owner.auditLog.findFirstOrThrow({
      where: { organizationId: org, action: 'customer.anonymize' },
    });
    expect(audit.entityId).toBe(id);
    expect(JSON.stringify(audit.details)).not.toContain('Ana');
  });

  it('hard-deletes a customer: interactions go, orders stay as guest revenue', async () => {
    const id = await customerWithHistory('Ben');
    expect((await api.post(`/customers/${id}/erase`, { mode: 'delete' })).status).toBe(204);
    expect(await ctx.owner.customer.count({ where: { id } })).toBe(0);
    expect(await ctx.owner.interaction.count({ where: { customerId: id } })).toBe(0);
    const orders = await ctx.owner.order.findMany({
      where: { organizationId: org, customerId: null },
    });
    expect(orders.length).toBeGreaterThanOrEqual(1);
    expect((await api.post(`/customers/${id}/erase`, { mode: 'delete' })).status).toBe(404);
  });

  it('is limited to owners and admins and validates the mode', async () => {
    const id = await customerWithHistory('Cleo');
    expect((await api.post(`/customers/${id}/erase`, { mode: 'shred' })).status).toBe(422);
    const session = await signup(ctx.app);
    await ctx.owner.membership.updateMany({
      where: { organizationId: session.body.organization.id },
      data: { role: 'ANALYST' },
    });
    const analyst = authed(ctx.app, (await refreshRequest(ctx.app, session)).body.accessToken);
    expect((await analyst.post(`/customers/${id}/erase`, { mode: 'delete' })).status).toBe(403);
    const outsider = authed(ctx.app, (await signup(ctx.app)).accessToken);
    expect((await outsider.post(`/customers/${id}/erase`, { mode: 'delete' })).status).toBe(404);
  });
});

describe('organization export', () => {
  it('produces a ZIP with every table as CSV', async () => {
    const queued = await api.post('/organization/export');
    expect(queued.status).toBe(202);
    expect((await api.post('/organization/export')).status).toBe(409); // one at a time
    await ctx.runJobs(['privacy.']);
    const job = await api.get(`/organization/export/${queued.body.jobId}`);
    expect(job.body.status).toBe('succeeded');
    const file = await api
      .get(`/organization/export/${queued.body.jobId}/file`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(file.headers['content-type']).toBe('application/zip');
    const files = unzip(file.body as Buffer);
    expect([...files.keys()]).toEqual([
      'README.txt',
      'organization.json',
      'customers.csv',
      'orders.csv',
      'order_items.csv',
      'interactions.csv',
      'segment_configs.csv',
      'audit_log.csv',
    ]);
    expect(JSON.parse(files.get('organization.json')!).name).toBe('Privacy Shop');
    expect(files.get('customers.csv')).toContain('cleo@example.com');
    expect(files.get('orders.csv')!.split('\r\n').length).toBeGreaterThan(3);
  });

  it('never exports another organization and is owner-only', async () => {
    const other = await signup(ctx.app);
    const otherApi = authed(ctx.app, other.accessToken);
    await otherApi.post('/customers', { externalId: 'X-1', email: 'secret@example.com' });
    const queued = await otherApi.post('/organization/export');
    await ctx.runJobs(['privacy.']);
    expect((await api.get(`/organization/export/${queued.body.jobId}`)).status).toBe(404);
    const file = await otherApi
      .get(`/organization/export/${queued.body.jobId}/file`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    const customers = unzip(file.body as Buffer).get('customers.csv')!;
    expect(customers).toContain('secret@example.com');
    expect(customers).not.toContain('cleo@example.com');
  });
});

describe('organization deletion', () => {
  it('requires the exact name, then removes all of its data', async () => {
    const victim = await signup(ctx.app, {
      organization: { name: 'Doomed Shop', timezone: 'UTC', currency: 'USD', industry: 'retail' },
    });
    const victimApi = authed(ctx.app, victim.accessToken);
    const victimOrg = victim.body.organization.id;
    await victimApi.post('/customers', { externalId: 'D-1', firstName: 'Dora' });
    await ctx.owner.analyticsRun.create({
      data: {
        id: '0193a2b4-0000-7000-8000-00000000dd01',
        organizationId: victimOrg,
        asOf: new Date('2026-11-18'),
        dataVersion: 1n,
        status: 'SUCCEEDED',
      },
    });
    const wrong = await victimApi.delete('/organization').send({ confirmName: 'Doomed' });
    expect(wrong.status).toBe(422);
    const res = await victimApi.delete('/organization').send({ confirmName: 'Doomed Shop' });
    expect(res.status).toBe(204);
    expect(await ctx.owner.organization.count({ where: { id: victimOrg } })).toBe(0);
    expect(await ctx.owner.customer.count({ where: { organizationId: victimOrg } })).toBe(0);
    expect(await ctx.owner.analyticsRun.count({ where: { organizationId: victimOrg } })).toBe(0);
    expect(await ctx.owner.membership.count({ where: { organizationId: victimOrg } })).toBe(0);
    // The account remains (it may belong to other organizations) but has no access left.
    expect(await ctx.owner.user.count({ where: { email: victim.email } })).toBe(1);
    expect((await refreshRequest(ctx.app, victim)).status).toBe(401);
    // Other organizations are untouched.
    expect(await ctx.owner.organization.count({ where: { id: org } })).toBe(1);
  });
});

describe('maintenance and metrics', () => {
  it('deletes old finished jobs and expired tokens, keeps recent ones', async () => {
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    await ctx.owner.job.create({
      data: {
        id: '0193a2b4-0000-7000-8000-00000000ee01',
        type: 'import.validate',
        status: 'SUCCEEDED',
        finishedAt: old,
      },
    });
    await ctx.owner.job.create({
      data: {
        id: '0193a2b4-0000-7000-8000-00000000ee02',
        type: 'import.validate',
        status: 'SUCCEEDED',
        finishedAt: new Date(),
      },
    });
    const removed = await cleanup(ctx.owner, ctx.storage);
    expect(removed.jobs).toBeGreaterThanOrEqual(1);
    expect(
      await ctx.owner.job.count({ where: { id: '0193a2b4-0000-7000-8000-00000000ee01' } }),
    ).toBe(0);
    expect(
      await ctx.owner.job.count({ where: { id: '0193a2b4-0000-7000-8000-00000000ee02' } }),
    ).toBe(1);
  });

  it('keeps the audit log append-only within 12 months for the runtime role', async () => {
    const deleted = await ctx.db.run({ organizationId: org }, (tx) =>
      tx.auditLog.deleteMany({ where: { organizationId: org } }),
    );
    expect(deleted.count).toBe(0);
  });

  it('serves metrics only with the token', async () => {
    // The test config has no METRICS_TOKEN: the endpoint does not exist.
    expect((await api.get('/metrics')).status).toBe(404);
  });
});

describe('expensive operation limits', () => {
  const limited = createTestContext({
    apiLimits: { requestsPerUserPerMinute: 1000, expensivePerOrgPerMinute: 2 },
  });
  afterAll(() => limited.close());

  it('limits exports per organization and says when to retry', async () => {
    const session = await signup(limited.app);
    const limitedApi = authed(limited.app, session.accessToken);
    expect((await limitedApi.post('/organization/export')).status).toBe(202);
    expect((await limitedApi.post('/organization/export')).status).toBe(409);
    const third = await limitedApi.post('/organization/export');
    expect(third.status).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    // Ordinary reads are not affected.
    expect((await limitedApi.get('/customers')).status).toBe(200);
  });
});
