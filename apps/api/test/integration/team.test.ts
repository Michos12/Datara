import { authResponseSchema } from '@ci/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API,
  authed,
  cookiesOf,
  createTestContext,
  refreshRequest,
  signup,
  type TestSession,
} from './harness.js';

const ctx = createTestContext();
let owner: TestSession;
let api: ReturnType<typeof authed>;
let org: string;
const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'another long passphrase 42';

/** The token from the latest email to `to` (links carry it in the URL fragment). */
function tokenFor(to: string): string {
  const email = [...ctx.mailer.sent].reverse().find((e) => e.to === to);
  if (!email) throw new Error(`no email to ${to}`);
  const match = /#token=([A-Za-z0-9_-]+)/.exec(email.text);
  return match![1]!;
}

const post = (path: string, body: object) => request(ctx.app).post(`${API}${path}`).send(body);

beforeAll(async () => {
  owner = await signup(ctx.app, {
    organization: { name: 'Team Shop', timezone: 'UTC', currency: 'USD', industry: 'retail' },
  });
  api = authed(ctx.app, owner.accessToken);
  org = owner.body.organization.id;
});
afterAll(() => ctx.close());

describe('invitations', () => {
  it('invites by email and lets a new person join with the assigned role', async () => {
    const res = await api.post('/organization/invitations', {
      email: 'New.Analyst@Example.com',
      role: 'ANALYST',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: 'new.analyst@example.com', role: 'ANALYST' });
    expect(res.body.emailSent).toBe(true);
    const email = ctx.mailer.sent.at(-1)!;
    expect(email.subject).toBe('Join Team Shop on Customer Insights');
    expect(email.text).toContain('http://app.test/invitation#token=');

    const pending = await api.get('/organization/invitations');
    expect(pending.body.data).toHaveLength(1);
    expect(pending.body.data[0].invitedBy).toBe('Test User');

    const token = tokenFor('new.analyst@example.com');
    const preview = await post('/invitations/preview', { token });
    expect(preview.body).toMatchObject({
      organizationName: 'Team Shop',
      role: 'ANALYST',
      accountExists: false,
    });

    const weak = await post('/invitations/accept', { token, password: 'short', fullName: 'Ana' });
    expect(weak.status).toBe(422);
    const accepted = await post('/invitations/accept', {
      token,
      password: PASSWORD,
      fullName: 'Ana Analyst',
    });
    expect(accepted.status).toBe(200);
    const session = authResponseSchema.parse(accepted.body);
    expect(session).toMatchObject({ role: 'ANALYST', organization: { id: org } });
    expect(cookiesOf(accepted).ci_refresh).toBeTruthy();

    const reused = await post('/invitations/accept', { token, password: PASSWORD, fullName: 'X' });
    expect(reused.status).toBe(400);
    expect((await api.get('/organization/invitations')).body.data).toHaveLength(0);
    const members = await api.get('/organization/members');
    expect(members.body.data.map((m: { role: string }) => m.role)).toEqual(['OWNER', 'ANALYST']);
  });

  it('lets an existing account join another organization and switch between them', async () => {
    const other = await signup(ctx.app, {
      organization: { name: 'Other Shop', timezone: 'UTC', currency: 'EUR', industry: 'retail' },
    });
    await api.post('/organization/invitations', { email: other.email, role: 'VIEWER' });
    const token = tokenFor(other.email);
    expect((await post('/invitations/preview', { token })).body.accountExists).toBe(true);
    const wrong = await post('/invitations/accept', { token, password: 'not the password' });
    expect(wrong.status).toBe(401);
    const joined = await post('/invitations/accept', { token, password: other.password });
    expect(joined.status).toBe(200);
    expect(joined.body.memberships).toHaveLength(2);
    expect(joined.body.organization.name).toBe('Team Shop');

    // Switch back to their own organization with the new session.
    const cookies = cookiesOf(joined);
    const switched = await request(ctx.app)
      .post(`${API}/auth/switch-organization`)
      .set('Authorization', `Bearer ${joined.body.accessToken}`)
      .set('Cookie', [`ci_refresh=${cookies.ci_refresh}`, `ci_csrf=${cookies.ci_csrf}`])
      .set('X-CSRF-Token', cookies.ci_csrf!)
      .send({ organizationId: other.body.organization.id });
    expect(switched.status).toBe(200);
    expect(switched.body).toMatchObject({ role: 'OWNER', organization: { name: 'Other Shop' } });
    // The old refresh token (Team Shop session) no longer works; the new one does.
    const old = await refreshRequest(ctx.app, {
      refresh: cookies.ci_refresh!,
      csrf: cookies.ci_csrf!,
    });
    expect(old.status).toBe(401);
    const next = cookiesOf(switched);
    const refreshed = await refreshRequest(ctx.app, {
      refresh: next.ci_refresh!,
      csrf: next.ci_csrf!,
    });
    expect(refreshed.status).toBe(200);

    const outsider = await request(ctx.app)
      .post(`${API}/auth/switch-organization`)
      .set('Authorization', `Bearer ${switched.body.accessToken}`)
      .set('Cookie', [`ci_csrf=${next.ci_csrf}`])
      .set('X-CSRF-Token', next.ci_csrf!)
      .send({ organizationId: (await signup(ctx.app)).body.organization.id });
    expect(outsider.status).toBe(403);
  });

  it('rejects expired and revoked invitations', async () => {
    await api.post('/organization/invitations', { email: 'late@example.com', role: 'VIEWER' });
    const late = tokenFor('late@example.com');
    ctx.advance(7 * DAY + 1000);
    const expired = await post('/invitations/accept', {
      token: late,
      password: PASSWORD,
      fullName: 'Late',
    });
    expect(expired.status).toBe(400);
    ctx.advance(-(7 * DAY + 1000));

    // Access tokens are short-lived: sign in again after moving the clock.
    const fresh = authed(ctx.app, (await refreshRequest(ctx.app, owner)).body.accessToken);
    const created = await fresh.post('/organization/invitations', {
      email: 'revoked@example.com',
      role: 'VIEWER',
    });
    expect((await fresh.delete(`/organization/invitations/${created.body.id}`)).status).toBe(204);
    const token = tokenFor('revoked@example.com');
    expect((await post('/invitations/preview', { token })).status).toBe(400);
    expect((await post('/invitations/preview', { token: 'x'.repeat(43) })).status).toBe(400);
  });

  it('re-sending an invitation replaces the pending one', async () => {
    await api.post('/organization/invitations', { email: 'twice@example.com', role: 'VIEWER' });
    const first = tokenFor('twice@example.com');
    await api.post('/organization/invitations', { email: 'twice@example.com', role: 'ADMIN' });
    expect((await post('/invitations/preview', { token: first })).status).toBe(400);
    const second = await post('/invitations/preview', { token: tokenFor('twice@example.com') });
    expect(second.body.role).toBe('ADMIN');
    const member = await api.post('/organization/invitations', {
      email: owner.email,
      role: 'VIEWER',
    });
    expect(member.status).toBe(409);
  });
});

describe('members', () => {
  it('protects owners from admins and keeps at least one owner', async () => {
    const admin = await signup(ctx.app);
    await api.post('/organization/invitations', { email: admin.email, role: 'ADMIN' });
    const joined = await post('/invitations/accept', {
      token: tokenFor(admin.email),
      password: admin.password,
    });
    const asAdmin = authed(ctx.app, joined.body.accessToken);
    const ownerId = owner.body.user.id;
    expect(
      (await asAdmin.patch(`/organization/members/${ownerId}`, { role: 'VIEWER' })).status,
    ).toBe(403);
    expect(
      (
        await asAdmin.post('/organization/invitations', {
          email: 'boss@example.com',
          role: 'OWNER',
        })
      ).status,
    ).toBe(403);
    expect((await asAdmin.delete(`/organization/members/${ownerId}`)).status).toBe(403);
    expect((await api.patch(`/organization/members/${ownerId}`, { role: 'ADMIN' })).status).toBe(
      409,
    );

    const promoted = await api.patch(`/organization/members/${admin.body.user.id}`, {
      role: 'OWNER',
    });
    expect(promoted.status).toBe(200);
    const removed = await api.delete(`/organization/members/${admin.body.user.id}`);
    expect(removed.status).toBe(204);
    const audit = await ctx.owner.auditLog.findMany({
      where: { organizationId: org, action: { in: ['member.role', 'member.remove'] } },
    });
    expect(audit).toHaveLength(2);
  });

  it('is not available to analysts', async () => {
    const analyst = await signup(ctx.app);
    await api.post('/organization/invitations', { email: analyst.email, role: 'ANALYST' });
    const joined = await post('/invitations/accept', {
      token: tokenFor(analyst.email),
      password: analyst.password,
    });
    const asAnalyst = authed(ctx.app, joined.body.accessToken);
    expect((await asAnalyst.get('/organization/members')).status).toBe(403);
    expect(
      (
        await asAnalyst.post('/organization/invitations', {
          email: 'x@example.com',
          role: 'VIEWER',
        })
      ).status,
    ).toBe(403);
  });
});

describe('password reset', () => {
  it('always answers 202 and emails a single-use link to real accounts', async () => {
    const before = ctx.mailer.sent.length;
    expect((await post('/auth/password/forgot', { email: 'nobody@example.com' })).status).toBe(202);
    expect(ctx.mailer.sent.length).toBe(before);

    const user = await signup(ctx.app);
    expect((await post('/auth/password/forgot', { email: user.email })).status).toBe(202);
    const email = ctx.mailer.sent.at(-1)!;
    expect(email.subject).toBe('Reset your Customer Insights password');
    expect(email.text).toContain('http://app.test/reset-password#token=');
    const token = tokenFor(user.email);

    expect((await post('/auth/password/reset', { token, newPassword: 'short' })).status).toBe(422);
    const reset = await post('/auth/password/reset', { token, newPassword: PASSWORD });
    expect(reset.status).toBe(204);
    expect((await post('/auth/password/reset', { token, newPassword: PASSWORD })).status).toBe(400);

    // Signed out everywhere; the old password no longer works, the new one does.
    expect((await refreshRequest(ctx.app, user)).status).toBe(401);
    expect((await post('/auth/login', { email: user.email, password: user.password })).status).toBe(
      401,
    );
    expect((await post('/auth/login', { email: user.email, password: PASSWORD })).status).toBe(200);
  });

  it('expires links after an hour and only the newest link works', async () => {
    const user = await signup(ctx.app);
    await post('/auth/password/forgot', { email: user.email });
    const first = tokenFor(user.email);
    await post('/auth/password/forgot', { email: user.email });
    const second = tokenFor(user.email);
    expect(
      (await post('/auth/password/reset', { token: first, newPassword: PASSWORD })).status,
    ).toBe(400);
    ctx.advance(61 * 60 * 1000);
    expect(
      (await post('/auth/password/reset', { token: second, newPassword: PASSWORD })).status,
    ).toBe(400);
    ctx.advance(-61 * 60 * 1000);
  });
});
