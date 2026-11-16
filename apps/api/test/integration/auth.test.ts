import { INDUSTRY_PRESETS, sessionSchema } from '@ci/contracts';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { REFRESH_REUSE_GRACE_MS } from '../../src/modules/auth/auth.service.js';
import {
  API,
  authed,
  cookiesOf,
  createTestContext,
  rawSetCookies,
  refreshRequest,
  signup,
  signupBody,
} from './harness.js';

const ctx = createTestContext();
afterAll(() => ctx.close());

describe('signup', () => {
  it('creates user, organization and owner membership, and starts a session', async () => {
    const body = signupBody();
    const res = await request(ctx.app).post(`${API}/auth/signup`).send(body);

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('OWNER');
    expect(res.body.user.email).toBe(body.email);
    expect(res.body.organization).toMatchObject({
      name: 'Test Org',
      currency: 'USD',
      timezone: 'America/Bogota',
      industry: 'restaurant',
      settings: INDUSTRY_PRESETS.restaurant,
    });
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body).not.toHaveProperty('passwordHash');

    const setCookies = rawSetCookies(res).join('\n');
    expect(setCookies).toMatch(
      /ci_refresh=[^;]+; Max-Age=\d+; Path=\/api\/v1\/auth; [^\n]*HttpOnly[^\n]*SameSite=Strict/,
    );
    expect(setCookies).toMatch(/ci_csrf=[^;]+; Max-Age=\d+; Path=\//);
    expect(setCookies).not.toMatch(/ci_csrf=[^\n]*HttpOnly/);
  });

  it('rejects a duplicate email regardless of case', async () => {
    const first = await signup(ctx.app);
    const res = await request(ctx.app)
      .post(`${API}/auth/signup`)
      .send(signupBody({ email: first.email.toUpperCase() }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });

  it('validates input and never echoes the password', async () => {
    const res = await request(ctx.app)
      .post(`${API}/auth/signup`)
      .send(signupBody({ password: 'short' }));
    expect(res.status).toBe(422);
    expect(res.body.errors[0].path).toBe('password');
    expect(JSON.stringify(res.body)).not.toContain('short"');
  });

  it('records an audit entry', async () => {
    const session = await signup(ctx.app);
    const res = await authed(ctx.app, session.accessToken).get('/organization/audit-logs');
    expect(res.body.data.map((e: { action: string }) => e.action)).toContain('auth.signup');
  });
});

describe('login', () => {
  it('returns a session for valid credentials', async () => {
    const session = await signup(ctx.app);
    const res = await request(ctx.app)
      .post(`${API}/auth/login`)
      .send({ email: session.email, password: session.password });
    expect(res.status).toBe(200);
    expect(sessionSchema.parse(res.body).organization.id).toBe(session.body.organization.id);
    expect(cookiesOf(res).ci_refresh).toBeDefined();
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const session = await signup(ctx.app);
    const wrong = await request(ctx.app)
      .post(`${API}/auth/login`)
      .send({ email: session.email, password: 'not the right password' });
    const unknown = await request(ctx.app)
      .post(`${API}/auth/login`)
      .send({ email: `nobody-${Date.now()}@example.com`, password: 'whatever password' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.detail).toBe(unknown.body.detail);
  });
});

describe('access tokens', () => {
  it('authorizes /auth/me and reports expiry distinctly', async () => {
    const session = await signup(ctx.app);
    const me = await authed(ctx.app, session.accessToken).get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(session.email);

    ctx.advance(16 * 60_000);
    try {
      const expired = await authed(ctx.app, session.accessToken).get('/auth/me');
      expect(expired.status).toBe(401);
      expect(expired.body.code).toBe('TOKEN_EXPIRED');
    } finally {
      ctx.advance(-16 * 60_000);
    }
  });
});

describe('refresh token rotation', () => {
  it('rotates the refresh token and issues a new access token', async () => {
    const session = await signup(ctx.app);
    const res = await refreshRequest(ctx.app, session);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    const rotated = cookiesOf(res).ci_refresh;
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(session.refresh);

    const next = await refreshRequest(ctx.app, {
      refresh: rotated!,
      csrf: cookiesOf(res).ci_csrf!,
    });
    expect(next.status).toBe(200);
  });

  it('tolerates a concurrent refresh within the grace window without rotating again', async () => {
    const session = await signup(ctx.app);
    expect((await refreshRequest(ctx.app, session)).status).toBe(200);
    const again = await refreshRequest(ctx.app, session);
    expect(again.status).toBe(200);
    expect(cookiesOf(again).ci_refresh).toBeUndefined();
  });

  it('treats reuse after the grace window as theft and revokes the whole family', async () => {
    const session = await signup(ctx.app);
    const first = await refreshRequest(ctx.app, session);
    const rotated = { refresh: cookiesOf(first).ci_refresh!, csrf: cookiesOf(first).ci_csrf! };

    ctx.advance(REFRESH_REUSE_GRACE_MS + 1000);
    try {
      const replay = await refreshRequest(ctx.app, session);
      expect(replay.status).toBe(401);
      // The legitimate holder's newer token is revoked too.
      expect((await refreshRequest(ctx.app, rotated)).status).toBe(401);
    } finally {
      ctx.advance(-(REFRESH_REUSE_GRACE_MS + 1000));
    }

    const audit = await authed(ctx.app, session.accessToken).get('/organization/audit-logs');
    expect(audit.body.data.map((e: { action: string }) => e.action)).toContain(
      'auth.refresh_reuse',
    );
  });

  it('requires the CSRF header', async () => {
    const session = await signup(ctx.app);
    const res = await request(ctx.app)
      .post(`${API}/auth/refresh`)
      .set('Cookie', [`ci_refresh=${session.refresh}`, `ci_csrf=${session.csrf}`]);
    expect(res.status).toBe(403);
  });

  it('rejects expired refresh tokens', async () => {
    const session = await signup(ctx.app);
    ctx.advance(15 * 24 * 60 * 60_000);
    try {
      expect((await refreshRequest(ctx.app, session)).status).toBe(401);
    } finally {
      ctx.advance(-15 * 24 * 60 * 60_000);
    }
  });

  it('picks up role changes on refresh', async () => {
    const session = await signup(ctx.app);
    await ctx.owner.membership.updateMany({
      where: { organizationId: session.body.organization.id },
      data: { role: 'VIEWER' },
    });
    const res = await refreshRequest(ctx.app, session);
    const me = await authed(ctx.app, res.body.accessToken).get('/auth/me');
    expect(me.body.role).toBe('VIEWER');
  });
});

describe('logout', () => {
  it('revokes the session and clears cookies', async () => {
    const session = await signup(ctx.app);
    const res = await request(ctx.app)
      .post(`${API}/auth/logout`)
      .set('Cookie', [`ci_refresh=${session.refresh}`, `ci_csrf=${session.csrf}`])
      .set('X-CSRF-Token', session.csrf);
    expect(res.status).toBe(204);
    expect(rawSetCookies(res).join('\n')).toMatch(/ci_refresh=;/);
    expect((await refreshRequest(ctx.app, session)).status).toBe(401);
  });
});

describe('rate limiting', () => {
  it('returns 429 after repeated failed logins for one account', async () => {
    const limited = createTestContext({
      rateLimits: { loginFailuresPerMinute: 3, authRequestsPerMinute: 100, refreshPerMinute: 100 },
    });
    try {
      const session = await signup(limited.app);
      const attempt = () =>
        request(limited.app)
          .post(`${API}/auth/login`)
          .send({ email: session.email, password: 'wrong password here' });
      for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
      const blocked = await attempt();
      expect(blocked.status).toBe(429);
      expect(blocked.body.code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });
});
