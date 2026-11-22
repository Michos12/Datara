import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { roleSchema, type Role } from '@ci/contracts';
import { errors, jwtVerify, SignJWT } from 'jose';
import type { Config } from '../../core/config.js';
import { AppError } from '../../core/errors.js';
import { isUuid, newId } from '../../core/ids.js';
import type { AuthContext } from '../../core/request-context.js';
import type { SessionPolicy } from './session-policy.js';

const ISSUER = 'customer-insights';
const AUDIENCE = 'customer-insights-api';
const ALG = 'HS256';

/** Short-lived JWT access tokens and opaque refresh tokens (ADR-0007). */
export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    private readonly config: Config['auth'],
    private readonly now: () => number = Date.now,
    /** Membership re-check and request limits applied by `requireAuth` (omitted in unit tests). */
    readonly policy?: SessionPolicy,
  ) {
    this.key = new TextEncoder().encode(config.jwtSecret);
  }

  get accessTokenTtlSeconds(): number {
    return this.config.accessTokenTtlSeconds;
  }

  get refreshTokenTtlMs(): number {
    return this.config.refreshTokenTtlDays * 24 * 60 * 60 * 1000;
  }

  async signAccessToken(ctx: AuthContext, now = this.now()): Promise<string> {
    const iat = Math.floor(now / 1000);
    return new SignJWT({ org: ctx.organizationId, role: ctx.role })
      .setProtectedHeader({ alg: ALG, typ: 'JWT' })
      .setSubject(ctx.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setJti(newId(now))
      .setIssuedAt(iat)
      .setExpirationTime(iat + this.config.accessTokenTtlSeconds)
      .sign(this.key);
  }

  /** Verifies signature, algorithm, issuer, audience and expiry; returns the auth context. */
  async verifyAccessToken(token: string): Promise<AuthContext> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: [ALG],
        currentDate: new Date(this.now()),
      });
      const role = roleSchema.safeParse(payload.role);
      const org = typeof payload.org === 'string' ? payload.org : '';
      if (!payload.sub || !isUuid(payload.sub) || !isUuid(org) || !role.success) {
        throw new AppError('UNAUTHENTICATED', 'Invalid access token');
      }
      return { userId: payload.sub, organizationId: org, role: role.data };
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof errors.JWTExpired) {
        throw new AppError('TOKEN_EXPIRED', 'Access token expired');
      }
      throw new AppError('UNAUTHENTICATED', 'Invalid access token');
    }
  }
}

/** 256-bit random opaque token, base64url. Only its hash is stored. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time string comparison for CSRF tokens. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type { Role };
