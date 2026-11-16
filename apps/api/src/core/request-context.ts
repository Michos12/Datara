import type { Role } from '@ci/contracts';
import type { Request } from 'express';
import { AppError } from './errors.js';

/** Identity of an authenticated request, resolved from the access token. */
export interface AuthContext {
  userId: string;
  organizationId: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/** The authenticated context. Throws 401 if a route forgot `requireAuth`. */
export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Authentication required');
  return req.auth;
}

/** Client IP for audit logs (respects the configured trust-proxy setting). */
export function clientIp(req: Request): string | null {
  return req.ip ?? null;
}
