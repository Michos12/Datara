import type { RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit, type RateLimitExceededEventHandler } from 'express-rate-limit';
import { AppError } from '../../core/errors.js';

export interface AuthRateLimits {
  /** Failed logins per IP + email per minute (AUTH-08). */
  loginFailuresPerMinute: number;
  /** All auth requests (signup, login) per IP per minute. */
  authRequestsPerMinute: number;
  /** Token refreshes per IP per minute. */
  refreshPerMinute: number;
}

export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimits = {
  loginFailuresPerMinute: 5,
  authRequestsPerMinute: 20,
  refreshPerMinute: 60,
};

const rejected: RateLimitExceededEventHandler = (_req, _res, next) => {
  next(new AppError('RATE_LIMITED', 'Too many attempts. Try again in a minute.'));
};

/**
 * In-memory stores: correct for a single API instance, which is the Render topology
 * (docs/08-deployment.md). A shared store (Postgres or Redis) is needed before running several.
 */
export function createAuthLimiters(limits: AuthRateLimits): {
  login: RequestHandler;
  auth: RequestHandler;
  refresh: RequestHandler;
} {
  return {
    login: rateLimit({
      windowMs: 60_000,
      limit: limits.loginFailuresPerMinute,
      // Count only failed attempts, keyed per IP and account so one attacker cannot lock out
      // everyone behind a shared IP, and one account cannot be brute-forced from many IPs
      // without also hitting the per-IP limit below.
      skipSuccessfulRequests: true,
      keyGenerator: (req) => {
        const email: unknown = (req.body as { email?: unknown } | undefined)?.email;
        return `${ipKeyGenerator(req.ip ?? '')}|${typeof email === 'string' ? email.trim().toLowerCase() : ''}`;
      },
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: rejected,
    }),
    auth: rateLimit({
      windowMs: 60_000,
      limit: limits.authRequestsPerMinute,
      keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: rejected,
    }),
    refresh: rateLimit({
      windowMs: 60_000,
      limit: limits.refreshPerMinute,
      keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: rejected,
    }),
  };
}
