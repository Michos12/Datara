import type { Role } from '@ci/contracts';
import type { RequestHandler } from 'express';
import { AppError } from '../../core/errors.js';
import type { TokenService } from './tokens.js';

/** Resolves `req.auth` from a Bearer access token, or responds 401. */
export function requireAuth(tokens: TokenService): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    req.auth = await tokens.verifyAccessToken(token);
    req.log = req.log.child({ userId: req.auth.userId, organizationId: req.auth.organizationId });
    next();
  };
}

/** Allows the request only for the listed roles (run after `requireAuth`). */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Authentication required');
    if (!roles.includes(req.auth.role)) {
      throw new AppError('FORBIDDEN', 'Your role does not allow this action');
    }
    next();
  };
}
