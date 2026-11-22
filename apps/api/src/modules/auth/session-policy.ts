import type { Role } from '@ci/contracts';
import type { Request, RequestHandler, Response } from 'express';
import { AppError } from '../../core/errors.js';
import type { AuthContext } from '../../core/request-context.js';
import type { Database } from '../../infra/database.js';
import type { TokenService } from './tokens.js';

/** Limits for authenticated traffic (docs/04-api-spec.md §4). */
export interface ApiRateLimits {
  /** Authenticated requests per user per minute. */
  requestsPerUserPerMinute: number;
  /** Exports, PDF reports, recomputes and demo data per organization per minute. */
  expensivePerOrgPerMinute: number;
}

export const DEFAULT_API_RATE_LIMITS: ApiRateLimits = {
  requestsPerUserPerMinute: 300,
  expensivePerOrgPerMinute: 10,
};

/**
 * Fixed one-minute windows in memory. Correct for one API instance (the Render topology); several
 * instances would each allow the full limit, so a shared store is needed before scaling out.
 */
export class FixedWindowLimiter {
  private windows = new Map<string, number>();
  private windowStart = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one hit; returns the seconds to wait when over the limit, else null. */
  hit(key: string): number | null {
    const now = this.now();
    if (now - this.windowStart >= this.windowMs) {
      // A new window: dropping the whole map keeps memory bounded by one minute of keys.
      this.windows = new Map();
      this.windowStart = now - (now % this.windowMs);
    }
    const count = (this.windows.get(key) ?? 0) + 1;
    this.windows.set(key, count);
    if (count <= this.limit) return null;
    return Math.max(1, Math.ceil((this.windowStart + this.windowMs - now) / 1000));
  }
}

/**
 * The role a user holds in an organization, read from the database and cached briefly, so a
 * removed or demoted member loses access within seconds instead of when their access token
 * expires. Team changes made through this process clear the entry at once.
 */
export class MembershipGuard {
  private readonly cache = new Map<string, { role: Role; at: number }>();

  constructor(
    private readonly db: Database,
    private readonly ttlMs = 10_000,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  async role(userId: string, organizationId: string): Promise<Role | null> {
    const key = `${userId}|${organizationId}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.role;
    const membership = await this.db.run({ organizationId, userId }, (tx) =>
      tx.membership.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: { role: true },
      }),
    );
    if (!membership) {
      this.cache.delete(key);
      return null;
    }
    if (this.cache.size >= this.maxEntries) this.cache.clear();
    this.cache.set(key, { role: membership.role, at: this.now() });
    return membership.role;
  }

  forget(userId: string, organizationId: string): void {
    this.cache.delete(`${userId}|${organizationId}`);
  }

  forgetOrganization(organizationId: string): void {
    for (const key of this.cache.keys()) {
      if (key.endsWith(`|${organizationId}`)) this.cache.delete(key);
    }
  }
}

function tooMany(res: Response, retryAfter: number, message: string): never {
  res.setHeader('Retry-After', String(retryAfter));
  throw new AppError('RATE_LIMITED', message);
}

/** What `requireAuth` checks after the token signature: membership and request rate. */
export class SessionPolicy {
  private readonly perUser: FixedWindowLimiter;
  private readonly perOrg: FixedWindowLimiter;

  constructor(
    readonly membership: MembershipGuard,
    limits: ApiRateLimits = DEFAULT_API_RATE_LIMITS,
  ) {
    this.perUser = new FixedWindowLimiter(limits.requestsPerUserPerMinute);
    this.perOrg = new FixedWindowLimiter(limits.expensivePerOrgPerMinute);
  }

  /** Confirms the membership (current role from the database) and counts the request. */
  async admit(res: Response, claims: AuthContext): Promise<AuthContext> {
    const role = await this.membership.role(claims.userId, claims.organizationId);
    if (!role) {
      throw new AppError('UNAUTHENTICATED', 'You are no longer a member of this organization');
    }
    const wait = this.perUser.hit(claims.userId);
    if (wait !== null) tooMany(res, wait, 'Too many requests. Try again in a minute.');
    return { ...claims, role };
  }

  /** Counts one expensive operation for the organization. */
  expensive(res: Response, organizationId: string): void {
    const wait = this.perOrg.hit(organizationId);
    if (wait !== null) {
      tooMany(
        res,
        wait,
        'Too many exports or recomputes for this organization. Try again shortly.',
      );
    }
  }
}

/**
 * Route guard for exports, PDF reports, recomputes and demo data (run after `requireAuth`):
 * at most `expensivePerOrgPerMinute` per organization.
 */
export function limitExpensive(tokens: TokenService): RequestHandler {
  return (req: Request, res, next) => {
    if (tokens.policy && req.auth) tokens.policy.expensive(res, req.auth.organizationId);
    next();
  };
}
