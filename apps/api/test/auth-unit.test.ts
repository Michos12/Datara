import cookieParser from 'cookie-parser';
import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config.js';
import { errorHandler } from '../src/core/errors.js';
import { newId } from '../src/core/ids.js';
import { requireAuth, requireRole } from '../src/modules/auth/auth.middleware.js';
import { assertCsrf } from '../src/modules/auth/cookies.js';
import { hashPassword, verifyPassword } from '../src/modules/auth/passwords.js';
import { hashToken, TokenService } from '../src/modules/auth/tokens.js';
import { makeSlug, resolveSettings } from '../src/modules/organizations/organization.mapper.js';
import { testConfig } from './helpers/config.js';

describe('passwords (argon2id)', () => {
  it('hashes in PHC format with OWASP parameters and verifies', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery stapler')).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password here')).not.toBe(
      await hashPassword('same password here'),
    );
  });

  it('returns false for malformed hashes instead of throwing', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
    expect(await verifyPassword('$argon2i$v=19$m=1,t=1,p=1$aa$bb', 'x')).toBe(false);
  });
});

describe('TokenService', () => {
  const tokens = new TokenService(testConfig().auth);
  const ctx = { userId: newId(), organizationId: newId(), role: 'ANALYST' as const };

  it('round-trips the auth context', async () => {
    const token = await tokens.signAccessToken(ctx);
    expect(await tokens.verifyAccessToken(token)).toEqual(ctx);
  });

  it('reports expiry distinctly so the client knows to refresh', async () => {
    const token = await tokens.signAccessToken(ctx, Date.now() - 2 * 900_000);
    await expect(tokens.verifyAccessToken(token)).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
  });

  it('rejects tokens signed with another secret', async () => {
    const other = new TokenService({ ...testConfig().auth, jwtSecret: 'x'.repeat(40) });
    const token = await other.signAccessToken(ctx);
    await expect(tokens.verifyAccessToken(token)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('rejects tampered payloads and the "none" algorithm', async () => {
    const token = await tokens.signAccessToken(ctx);
    const [header, payload, signature] = token.split('.');
    const forged = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    forged.role = 'OWNER';
    const tampered = `${header}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`;
    await expect(tokens.verifyAccessToken(tampered)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${payload}.`;
    await expect(tokens.verifyAccessToken(none)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('hashes refresh tokens deterministically without storing the token', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toContain('abc');
    expect(hashToken('abc')).toHaveLength(64);
  });
});

describe('auth middleware', () => {
  const tokens = new TokenService(testConfig().auth);
  const app = express();
  app.use((req, _res, next) => {
    req.log = pino({ level: 'silent' });
    next();
  });
  app.get('/viewer', requireAuth(tokens), (req, res) => res.json(req.auth));
  app.get('/admin', requireAuth(tokens), requireRole('OWNER', 'ADMIN'), (_req, res) =>
    res.json({ ok: true }),
  );
  app.use(errorHandler);

  it('rejects missing and malformed Authorization headers', async () => {
    expect((await request(app).get('/viewer')).status).toBe(401);
    expect((await request(app).get('/viewer').set('Authorization', 'Basic abc')).status).toBe(401);
  });

  it('enforces roles', async () => {
    const viewer = await tokens.signAccessToken({
      userId: newId(),
      organizationId: newId(),
      role: 'VIEWER',
    });
    const res = await request(app).get('/admin').set('Authorization', `Bearer ${viewer}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});

describe('CSRF double-submit check', () => {
  const app = express();
  app.use(cookieParser());
  app.use((req, _res, next) => {
    req.log = pino({ level: 'silent' });
    next();
  });
  app.post('/x', (req, res) => {
    assertCsrf(req);
    res.json({ ok: true });
  });
  app.use(errorHandler);

  it('requires the header to match the cookie', async () => {
    const ok = await request(app)
      .post('/x')
      .set('Cookie', 'ci_csrf=abc')
      .set('X-CSRF-Token', 'abc');
    expect(ok.status).toBe(200);
    const missing = await request(app).post('/x').set('Cookie', 'ci_csrf=abc');
    expect(missing.status).toBe(403);
    const wrong = await request(app)
      .post('/x')
      .set('Cookie', 'ci_csrf=abc')
      .set('X-CSRF-Token', 'abd');
    expect(wrong.status).toBe(403);
  });
});

describe('organization mapper', () => {
  it('builds URL-safe slugs from accented names', () => {
    expect(makeSlug('Café Central & Co.', 'a1b2')).toBe('cafe-central-co-a1b2');
    expect(makeSlug('!!!', 'a1b2')).toBe('org-a1b2');
  });

  it('fills settings missing from older rows with the industry preset', () => {
    const settings = resolveSettings('restaurant', { churnDays: 120 });
    expect(settings).toMatchObject({ activeWindowDays: 30, churnDays: 120, defaultGrain: 'week' });
  });

  it('falls back to the preset when stored settings are invalid', () => {
    expect(resolveSettings('retail', { churnDays: -1 }).churnDays).toBe(180);
  });
});

describe('config', () => {
  const env = {
    DATABASE_URL: 'postgresql://a:b@localhost:5432/db',
    ANALYTICS_SERVICE_TOKEN: 'a-sufficiently-long-token',
    JWT_SECRET: 'j'.repeat(32),
  };

  it('requires a long JWT secret', () => {
    expect(() => loadConfig({ ...env, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('defaults secure cookies on in production only', () => {
    expect(loadConfig({ ...env, NODE_ENV: 'production' }).auth.cookieSecure).toBe(true);
    expect(loadConfig(env).auth.cookieSecure).toBe(false);
    expect(loadConfig({ ...env, COOKIE_SECURE: 'true' }).auth.cookieSecure).toBe(true);
  });

  it('parses trust proxy settings', () => {
    expect(loadConfig(env).trustProxy).toBe(false);
    expect(loadConfig({ ...env, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ ...env, TRUST_PROXY: 'loopback' }).trustProxy).toBe('loopback');
  });
});
