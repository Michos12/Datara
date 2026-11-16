import { AUTH_COOKIES, CSRF_HEADER } from '@ci/contracts';
import type { CookieOptions, Request, Response } from 'express';
import { AppError } from '../../core/errors.js';
import { generateOpaqueToken, safeEqual } from './tokens.js';

/** The refresh cookie is only ever sent to the auth endpoints. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export interface CookieSettings {
  secure: boolean;
  refreshTtlMs: number;
}

function base(settings: CookieSettings): CookieOptions {
  return { secure: settings.secure, sameSite: 'strict' };
}

/**
 * Sets the httpOnly refresh cookie and a readable CSRF cookie (double-submit pattern):
 * the SPA echoes the CSRF value in a header, which a cross-site page cannot read or forge.
 */
export function setSessionCookies(
  res: Response,
  refreshToken: string,
  settings: CookieSettings,
): void {
  res.cookie(AUTH_COOKIES.refresh, refreshToken, {
    ...base(settings),
    httpOnly: true,
    path: REFRESH_COOKIE_PATH,
    maxAge: settings.refreshTtlMs,
  });
  res.cookie(AUTH_COOKIES.csrf, generateOpaqueToken(), {
    ...base(settings),
    httpOnly: false,
    path: '/',
    maxAge: settings.refreshTtlMs,
  });
}

export function clearSessionCookies(res: Response, settings: CookieSettings): void {
  res.clearCookie(AUTH_COOKIES.refresh, {
    ...base(settings),
    httpOnly: true,
    path: REFRESH_COOKIE_PATH,
  });
  res.clearCookie(AUTH_COOKIES.csrf, { ...base(settings), path: '/' });
}

export function readRefreshCookie(req: Request): string | null {
  const value: unknown = req.cookies?.[AUTH_COOKIES.refresh];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Rejects cookie-authenticated requests whose CSRF header does not match the CSRF cookie. */
export function assertCsrf(req: Request): void {
  const cookie: unknown = req.cookies?.[AUTH_COOKIES.csrf];
  const header = req.get(CSRF_HEADER);
  if (typeof cookie !== 'string' || !cookie || !header || !safeEqual(cookie, header)) {
    throw new AppError('FORBIDDEN', 'CSRF token missing or invalid');
  }
}
