import {
  acceptInvitationRequestSchema,
  forgotPasswordRequestSchema,
  invitationPreviewRequestSchema,
  loginRequestSchema,
  resetPasswordRequestSchema,
  signupRequestSchema,
  switchOrganizationRequestSchema,
  type Session,
} from '@ci/contracts';
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

  /** Starts a session in another organization of the same user (AUTH-05). */
  router.post('/auth/switch-organization', requireAuth(tokens), async (req, res) => {
    assertCsrf(req);
    const body = switchOrganizationRequestSchema.parse(req.body);
    const { response, refreshToken } = await auth.switchOrganization(
      getAuth(req),
      body.organizationId,
      readRefreshCookie(req),
      clientIp(req),
    );
    setSessionCookies(res, refreshToken, cookies);
    res.json(response);
  });

  /** Always 202: the answer never reveals whether the email has an account (AUTH-06). */
  router.post('/auth/password/forgot', limit.auth, async (req, res) => {
    const body = forgotPasswordRequestSchema.parse(req.body);
    await auth.forgotPassword(body.email);
    res.status(202).json({ status: 'accepted' });
  });

  router.post('/auth/password/reset', limit.auth, async (req, res) => {
    const body = resetPasswordRequestSchema.parse(req.body);
    await auth.resetPassword(body.token, body.newPassword, clientIp(req));
    clearSessionCookies(res, cookies);
    res.status(204).end();
  });

  /** Tokens travel in the body, never in URLs, so they stay out of access logs. */
  router.post('/invitations/preview', limit.auth, async (req, res) => {
    const body = invitationPreviewRequestSchema.parse(req.body);
    res.json(await auth.previewInvitation(body.token));
  });

  router.post('/invitations/accept', limit.auth, async (req, res) => {
    const body = acceptInvitationRequestSchema.parse(req.body);
    const { response, refreshToken } = await auth.acceptInvitation(body, clientIp(req));
    setSessionCookies(res, refreshToken, cookies);
    res.json(response);
  });

  router.get('/auth/me', requireAuth(tokens), async (req, res) => {
    const session: Session = await auth.session(getAuth(req));
    res.json(session);
  });

  return router;
}
