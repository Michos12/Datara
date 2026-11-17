import { importSchema, importUploadResponseSchema } from '@ci/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, createTestContext, refreshRequest, signup, type TestSession } from './harness.js';

const ctx = createTestContext();
let session: TestSession;
let api: ReturnType<typeof authed>;
let org: string;
let ana: string;
let ben: string;

async function version(): Promise<number> {
  const row = await ctx.owner.organization.findUniqueOrThrow({ where: { id: org } });
  return Number(row.dataVersion);
}

beforeAll(async () => {
  session = await signup(ctx.app);
  api = authed(ctx.app, session.accessToken);
  org = session.body.organization.id;
  ana = (await api.post('/customers', { externalId: 'C-1', firstName: 'Ana' })).body.id;
  ben = (await api.post('/customers', { externalId: 'C-2', firstName: 'Ben' })).body.id;
});
afterAll(() => ctx.close());

describe('interactions', () => {
  it('creates one, bumps the data version and lists it on the timeline', async () => {
    const before = await version();
    const res = await api.post('/interactions', {
      customerId: ana,
      type: 'email_clicked',
      occurredAt: '2026-10-01T10:00:00-05:00',
      channel: 'email',
      metadata: { campaign: 'October' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      customerId: ana,
      type: 'email_clicked',
      channel: 'email',
      occurredAt: '2026-10-01T15:00:00.000Z',
      metadata: { campaign: 'October' },
      externalId: null,
    });
    expect(await version()).toBe(before + 1);

    const timeline = await api.get(`/customers/${ana}/interactions`);
    expect(timeline.status).toBe(200);
    expect(timeline.body.data).toHaveLength(1);
    expect((await api.get(`/customers/${ben}/interactions`)).body.data).toEqual([]);
  });

  it('validates the body', async () => {
    const base = { customerId: ana, type: 'review', occurredAt: '2026-10-02T00:00:00Z' };
    expect((await api.post('/interactions', { ...base, type: 'tweet' })).status).toBe(422);
    const dateOnly = await api.post('/interactions', { ...base, occurredAt: '2026-10-02' });
    expect(dateOnly.status).toBe(422);
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    expect((await api.post('/interactions', { ...base, occurredAt: future })).status).toBe(422);
    const nested = await api.post('/interactions', { ...base, metadata: { a: { b: 1 } } });
    expect(nested.status).toBe(422);
    const unknown = await api.post('/interactions', {
      ...base,
      customerId: '0193a2b4-0000-7000-8000-000000000999',
    });
    expect(unknown.status).toBe(404);
  });

  it('upserts a batch by external ID and pages with filters', async () => {
    const batch = (types: string[]) => ({
      interactions: types.map((type, i) => ({
        customerId: i % 2 ? ben : ana,
        type,
        occurredAt: `2026-09-${String(10 + i).padStart(2, '0')}T12:00:00Z`,
        externalId: `I-${i}`,
      })),
    });
    const first = await api.post(
      '/interactions/batch',
      batch(['website_visit', 'review', 'other']),
    );
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ inserted: 3, updated: 0 });
    const again = await api.post(
      '/interactions/batch',
      batch(['website_visit', 'loyalty_signup', 'other']),
    );
    expect(again.body).toEqual({ inserted: 0, updated: 3 });

    expect((await api.get('/interactions?type=review')).body.data).toHaveLength(0);
    const loyalty = await api.get('/interactions?type=loyalty_signup');
    expect(loyalty.body.data.map((i: { externalId: string }) => i.externalId)).toEqual(['I-1']);

    const page = await api.get('/interactions?limit=2');
    expect(page.body.data).toHaveLength(2);
    expect(page.body.page.nextCursor).not.toBeNull();
    const rest = await api.get(`/interactions?limit=2&cursor=${page.body.page.nextCursor}`);
    expect(rest.body.data).toHaveLength(2);
    const ranged = await api.get('/interactions?from=2026-09-11T00:00:00Z&to=2026-09-12T00:00:00Z');
    expect(ranged.body.data).toHaveLength(1);
  });

  it('rejects batches with unknown customers or repeated IDs', async () => {
    const row = { type: 'other', occurredAt: '2026-09-01T00:00:00Z' };
    const unknown = await api.post('/interactions/batch', {
      interactions: [
        { ...row, customerId: ana },
        { ...row, customerId: '0193a2b4-0000-7000-8000-000000000999' },
      ],
    });
    expect(unknown.status).toBe(422);
    expect(JSON.stringify(unknown.body)).toContain('interactions.1.customerId');
    const repeated = await api.post('/interactions/batch', {
      interactions: [
        { ...row, customerId: ana, externalId: 'X' },
        { ...row, customerId: ben, externalId: 'X' },
      ],
    });
    expect(repeated.status).toBe(422);
    expect((await api.post('/interactions/batch', { interactions: [] })).status).toBe(422);
  });

  it('deletes for admins only and hides other tenants', async () => {
    const created = await api.post('/interactions', {
      customerId: ana,
      type: 'support_ticket',
      occurredAt: '2026-10-05T00:00:00Z',
    });
    const other = authed(ctx.app, (await signup(ctx.app)).accessToken);
    expect((await other.get(`/customers/${ana}/interactions`)).status).toBe(404);
    expect((await other.get('/interactions')).body.data).toEqual([]);
    expect((await other.delete(`/interactions/${created.body.id}`)).status).toBe(404);

    const viewerSession = await signup(ctx.app);
    await ctx.owner.membership.updateMany({
      where: { organizationId: viewerSession.body.organization.id },
      data: { role: 'VIEWER' },
    });
    const viewer = authed(ctx.app, (await refreshRequest(ctx.app, viewerSession)).body.accessToken);
    const denied = await viewer.post('/interactions', {
      customerId: ana,
      type: 'other',
      occurredAt: '2026-10-05T00:00:00Z',
    });
    expect(denied.status).toBe(403);

    expect((await api.delete(`/interactions/${created.body.id}`)).status).toBe(204);
    expect((await api.delete(`/interactions/${created.body.id}`)).status).toBe(404);
  });

  it('drops interactions from lists when the customer is deleted', async () => {
    const carl = (await api.post('/customers', { externalId: 'C-3', firstName: 'Carl' })).body.id;
    await api.post('/interactions', {
      customerId: carl,
      type: 'review',
      occurredAt: '2026-10-05T00:00:00Z',
    });
    expect((await api.delete(`/customers/${carl}`)).status).toBe(204);
    expect((await api.get(`/customers/${carl}/interactions`)).status).toBe(404);
    const all = await api.get('/interactions?type=review');
    expect(all.body.data.some((i: { customerId: string }) => i.customerId === carl)).toBe(false);
  });
});

describe('interaction import', () => {
  it('imports, cross-checks customers and reports bad types', async () => {
    const csv =
      'Event ID,Customer ID,Type,Date,Channel\r\n' +
      'E-1,C-1,Email opened,2026-08-01 09:00,email\r\n' +
      'E-2,C-2,website_visit,2026-08-02,web\r\n' +
      'E-3,C-404,review,2026-08-03,web\r\n' +
      'E-4,C-1,tweet,2026-08-04,web\r\n';
    const upload = await api.upload('interactions', csv);
    expect(upload.status).toBe(201);
    const body = importUploadResponseSchema.parse(upload.body);
    expect(body.suggestedMapping).toMatchObject({
      externalId: 'Event ID',
      customerExternalId: 'Customer ID',
      type: 'Type',
      occurredAt: 'Date',
      channel: 'Channel',
    });
    const mapped = await api.put(`/imports/${body.import.id}/mapping`, {
      mapping: body.suggestedMapping,
    });
    expect(mapped.status).toBe(202);
    await ctx.runJobs();
    const validated = importSchema.parse((await api.get(`/imports/${body.import.id}`)).body);
    expect(validated).toMatchObject({ status: 'validated', rowsValid: 2, rowsFailed: 2 });
    expect(validated.errorSample.map((e) => e.field)).toEqual(['customerExternalId', 'type']);

    expect((await api.post(`/imports/${body.import.id}/commit`)).status).toBe(202);
    await ctx.runJobs();
    const done = importSchema.parse((await api.get(`/imports/${body.import.id}`)).body);
    expect(done).toMatchObject({ status: 'completed', rowsInserted: 2 });

    const opened = await api.get(`/customers/${ana}/interactions?type=email_opened`);
    // 09:00 in America/Bogota (UTC-5)
    expect(opened.body.data[0]).toMatchObject({
      externalId: 'E-1',
      occurredAt: '2026-08-01T14:00:00.000Z',
    });

    const template = await api.get('/imports/templates/interactions.csv');
    expect(template.status).toBe(200);
    expect(template.text).toContain('externalId,customerExternalId,type,occurredAt,channel');
  });
});
