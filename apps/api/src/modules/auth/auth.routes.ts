import { loginRequestSchema, signupRequestSchema, type Session } from '@ci/contracts';
import { Router } from 'express';
import { AppError } from '../../core/errors.js';
import { clientIp, getAuth } from '../../core/request-context.js';
import { requireAuth } from './auth.middleware.js';
import type { AuthService } from './auth.service.js';
import {
  assertCsrf,
  clearSessionCookies,
  readRefreshCookie,
  setSessionCookies,
  type CookieSettings,
} from './cookies.js';
import { createAuthLimiters, type AuthRateLimits } from './rate-limits.js';
import type { TokenService } from './tokens.js';

export function authRouter(deps: {
  auth: AuthService;
  tokens: TokenService;
  cookies: CookieSettings;
  rateLimits: AuthRateLimits;
}): Router {
  const { auth, tokens, cookies } = deps;
  const limit = createAuthLimiters(deps.rateLimits);
  const router = Router();

  router.post('/auth/signup', limit.auth, async (req, res) => {
    const body = signupRequestSchema.parse(req.body);
    const { response, refreshToken } = await auth.signup(body, clientIp(req));
    setSessionCookies(res, refreshToken, cookies);
    res.status(201).json(response);
  });

  router.post('/auth/login', limit.auth, limit.login, async (req, res) => {
    const body = loginRequestSchema.parse(req.body);
    const { response, refreshToken } = await auth.login(body, clientIp(req));
    setSessionCookies(res, refreshToken, cookies);
    res.json(response);
  });

  router.post('/auth/refresh', limit.refresh, async (req, res) => {
    assertCsrf(req);
    const presented = readRefreshCookie(req);
    if (!presented) {
      clearSessionCookies(res, cookies);
      throw new AppError('UNAUTHENTICATED', 'No active session');
    }
    try {
      const outcome = await auth.refresh(presented, clientIp(req));
      if (outcome.kind === 'rotated') setSessionCookies(res, outcome.refreshToken, cookies);
      res.json(outcome.response);
    } catch (err) {
      clearSessionCookies(res, cookies);
      throw err;
    }
  });

  router.post('/auth/logout', async (req, res) => {
    assertCsrf(req);
    await auth.logout(readRefreshCookie(req), clientIp(req));
    clearSessionCookies(res, cookies);
    res.status(204).end();
  });

  router.get('/auth/me', requireAuth(tokens), async (req, res) => {
    const session: Session = await auth.session(getAuth(req));
    res.json(session);
  });

  return router;
}
