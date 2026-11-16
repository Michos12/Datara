import { INDUSTRY_PRESETS } from '@ci/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { authed, createTestContext, refreshRequest, signup } from './harness.js';

const ctx = createTestContext();
afterAll(() => ctx.close());

describe('GET /organization', () => {
  it('returns the active organization', async () => {
    const session = await signup(ctx.app, {
      organization: {
        name: 'Mercado Sol',
        timezone: 'Europe/Madrid',
        currency: 'EUR',
        industry: 'retail',
      },
    });
    const res = await authed(ctx.app, session.accessToken).get('/organization');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Mercado Sol',
      currency: 'EUR',
      settings: INDUSTRY_PRESETS.retail,
    });
    expect(res.body.slug).toMatch(/^mercado-sol-[0-9a-f]{8}$/);
  });
});

describe('PATCH /organization', () => {
  it('updates fields and records what changed', async () => {
    const session = await signup(ctx.app);
    const api = authed(ctx.app, session.accessToken);
    const settings = { ...INDUSTRY_PRESETS.restaurant, activeWindowDays: 45, churnDays: 120 };

    const res = await api.patch('/organization', { name: 'Renamed', timezone: 'UTC', settings });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Renamed', timezone: 'UTC', settings });

    const audit = await api.get('/organization/audit-logs?limit=1');
    expect(audit.body.data[0]).toMatchObject({
      action: 'organization.update',
      details: { name: { from: 'Test Org', to: 'Renamed' } },
    });
  });

  it('rejects inconsistent settings and immutable fields', async () => {
    const session = await signup(ctx.app);
    const api = authed(ctx.app, session.accessToken);
    const bad = await api.patch('/organization', {
      settings: { ...INDUSTRY_PRESETS.retail, activeWindowDays: 200, churnDays: 100 },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].path).toBe('settings.churnDays');

    expect((await api.patch('/organization', { currency: 'EUR' })).status).toBe(422);
    expect((await api.patch('/organization', { timezone: 'Mars/Base' })).status).toBe(422);
  });

  it('is limited to owners and admins', async () => {
    const session = await signup(ctx.app);
    await ctx.owner.membership.updateMany({
      where: { organizationId: session.body.organization.id },
      data: { role: 'ANALYST' },
    });
    const refreshed = await refreshRequest(ctx.app, session);
    const api = authed(ctx.app, refreshed.body.accessToken);
    expect((await api.patch('/organization', { name: 'Nope' })).status).toBe(403);
    expect((await api.get('/organization/audit-logs')).status).toBe(403);
    expect((await api.get('/organization')).status).toBe(200);
  });
});

describe('GET /organization/audit-logs', () => {
  it('paginates newest first with a cursor', async () => {
    const session = await signup(ctx.app);
    const api = authed(ctx.app, session.accessToken);
    for (const name of ['One', 'Two', 'Three']) await api.patch('/organization', { name });

    const first = await api.get('/organization/audit-logs?limit=2');
    expect(first.body.data).toHaveLength(2);
    expect(first.body.data[0].details.name.to).toBe('Three');
    expect(first.body.page.nextCursor).toEqual(expect.any(String));

    const second = await api.get(
      `/organization/audit-logs?limit=2&cursor=${first.body.page.nextCursor}`,
    );
    expect(second.body.data[0].details.name.to).toBe('One');
    const ids = [...first.body.data, ...second.body.data].map((e: { id: string }) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
