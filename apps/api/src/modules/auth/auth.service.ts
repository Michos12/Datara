import { randomBytes } from 'node:crypto';
import {
  INDUSTRY_PRESETS,
  type AuthResponse,
  type LoginRequest,
  type RefreshResponse,
  type Session,
  type SignupRequest,
} from '@ci/contracts';
import { AppError } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import type { AuthContext } from '../../core/request-context.js';
import { isUniqueViolation, type Database, type Tx } from '../../infra/database.js';
import { recordAudit } from '../audit/audit.service.js';
import { makeSlug, toOrganization } from '../organizations/organization.mapper.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './passwords.js';
import { generateOpaqueToken, hashToken, type TokenService } from './tokens.js';

/**
 * A refresh token presented again within this window after it was rotated is treated as a
 * benign race (two tabs refreshing at once), not as token theft.
 */
export const REFRESH_REUSE_GRACE_MS = 15_000;

export interface IssuedSession {
  response: AuthResponse;
  refreshToken: string;
}

export type RefreshOutcome =
  /** Normal rotation: set the new refresh cookie. */
  | { kind: 'rotated'; response: RefreshResponse; refreshToken: string }
  /** Concurrent refresh inside the grace window: new access token, keep the current cookie. */
  | { kind: 'grace'; response: RefreshResponse };

const INVALID_CREDENTIALS = 'Invalid email or password';
const SESSION_EXPIRED = 'Session expired. Please sign in again.';

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly tokens: TokenService,
    private readonly now: () => number = Date.now,
  ) {}

  async signup(input: SignupRequest, ip: string | null): Promise<IssuedSession> {
    const existing = await this.db.run({}, (tx) =>
      tx.user.findUnique({ where: { email: input.email }, select: { id: true } }),
    );
    if (existing) throw new AppError('CONFLICT', 'An account with this email already exists');

    const passwordHash = await hashPassword(input.password);
    const userId = newId();
    const organizationId = newId();

    try {
      const refreshToken = await this.db.run({ organizationId, userId }, async (tx) => {
        await tx.user.create({
          data: { id: userId, email: input.email, passwordHash, fullName: input.fullName },
        });
        await tx.organization.create({
          data: {
            id: organizationId,
            name: input.organization.name,
            slug: makeSlug(input.organization.name, randomBytes(4).toString('hex')),
            timezone: input.organization.timezone,
            currency: input.organization.currency,
            industry: input.organization.industry,
            settings: INDUSTRY_PRESETS[input.organization.industry],
          },
        });
        await tx.membership.create({
          data: { id: newId(), organizationId, userId, role: 'OWNER' },
        });
        await recordAudit(tx, {
          organizationId,
          actorUserId: userId,
          action: 'auth.signup',
          entityType: 'user',
          entityId: userId,
          details: { industry: input.organization.industry },
          ip,
        });
        const { token } = await this.createRefreshToken(tx, {
          userId,
          organizationId,
          familyId: newId(),
        });
        return token;
      });
      const ctx: AuthContext = { userId, organizationId, role: 'OWNER' };
      return { refreshToken, response: await this.withAccessToken(ctx) };
    } catch (err) {
      // Two signups racing for the same email: the unique index decides.
      if (isUniqueViolation(err)) {
        throw new AppError('CONFLICT', 'An account with this email already exists');
      }
      throw err;
    }
  }

  async login(input: LoginRequest, ip: string | null): Promise<IssuedSession> {
    const user = await this.db.run({}, (tx) =>
      tx.user.findUnique({ where: { email: input.email } }),
    );
    // Always run the hash, so timing does not reveal whether the email exists.
    const valid = await verifyPassword(user?.passwordHash ?? DUMMY_PASSWORD_HASH, input.password);
    if (!user || !valid) throw new AppError('UNAUTHENTICATED', INVALID_CREDENTIALS);

    const membership = await this.db.run({ userId: user.id }, (tx) =>
      tx.membership.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } }),
    );
    if (!membership) throw new AppError('FORBIDDEN', 'This account has no organization access');

    const ctx: AuthContext = {
      userId: user.id,
      organizationId: membership.organizationId,
      role: membership.role,
    };
    const refreshToken = await this.db.run(ctx, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(this.now()) } });
      await recordAudit(tx, {
        organizationId: ctx.organizationId,
        actorUserId: user.id,
        action: 'auth.login',
        ip,
      });
      const { token } = await this.createRefreshToken(tx, { ...ctx, familyId: newId() });
      return token;
    });
    return { refreshToken, response: await this.withAccessToken(ctx) };
  }

  /**
   * Rotates a refresh token. Reuse of an already-rotated token outside the grace window means
   * it was probably stolen: the whole token family is revoked and the user must sign in again.
   */
  async refresh(presented: string, ip: string | null): Promise<RefreshOutcome> {
    const now = this.now();
    const stored = await this.db.run({}, (tx) =>
      tx.refreshToken.findUnique({ where: { tokenHash: hashToken(presented) } }),
    );
    if (!stored) throw new AppError('UNAUTHENTICATED', SESSION_EXPIRED);

    if (stored.revokedAt) {
      const sinceRevoked = now - stored.revokedAt.getTime();
      if (stored.replacedById && sinceRevoked <= REFRESH_REUSE_GRACE_MS) {
        const ctx = await this.currentContext(stored.userId, stored.organizationId);
        if (ctx) return { kind: 'grace', response: await this.accessTokenResponse(ctx) };
      }
      await this.revokeFamily(stored.familyId, now, {
        organizationId: stored.organizationId,
        userId: stored.userId,
        action: 'auth.refresh_reuse',
        ip,
      });
      throw new AppError('UNAUTHENTICATED', SESSION_EXPIRED);
    }

    if (stored.expiresAt.getTime() <= now) throw new AppError('UNAUTHENTICATED', SESSION_EXPIRED);

    // Role or membership may have changed since the last token: re-read it.
    const ctx = await this.currentContext(stored.userId, stored.organizationId);
    if (!ctx) {
      await this.revokeFamily(stored.familyId, now);
      throw new AppError('UNAUTHENTICATED', SESSION_EXPIRED);
    }

    const rotated = await this.db.run(ctx, async (tx) => {
      const next = await this.createRefreshToken(tx, { ...ctx, familyId: stored.familyId });
      // Conditional update: only one concurrent request can rotate a given token.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: new Date(now), replacedById: next.id },
      });
      if (count !== 1) {
        await tx.refreshToken.delete({ where: { id: next.id } });
        return null;
      }
      return next.token;
    });

    const response = await this.accessTokenResponse(ctx);
    return rotated
      ? { kind: 'rotated', response, refreshToken: rotated }
      : { kind: 'grace', response };
  }

  /** Revokes the session's whole token family. Idempotent. */
  async logout(presented: string | null, ip: string | null): Promise<void> {
    if (!presented) return;
    const stored = await this.db.run({}, (tx) =>
      tx.refreshToken.findUnique({ where: { tokenHash: hashToken(presented) } }),
    );
    if (!stored) return;
    await this.revokeFamily(stored.familyId, this.now(), {
      organizationId: stored.organizationId,
      userId: stored.userId,
      action: 'auth.logout',
      ip,
    });
  }

  /** Current session for an access token. 401 if the membership no longer exists. */
  async session(auth: AuthContext): Promise<Session> {
    const session = await this.loadSession(auth.userId, auth.organizationId);
    if (!session) throw new AppError('UNAUTHENTICATED', SESSION_EXPIRED);
    return session;
  }

  // ───────────── helpers ─────────────

  private async withAccessToken(ctx: AuthContext): Promise<AuthResponse> {
    const session = await this.loadSession(ctx.userId, ctx.organizationId);
    if (!session) throw new AppError('INTERNAL', 'Session could not be loaded');
    return { ...session, ...(await this.accessTokenResponse(ctx)) };
  }

  private async accessTokenResponse(ctx: AuthContext): Promise<RefreshResponse> {
    return {
      accessToken: await this.tokens.signAccessToken(ctx, this.now()),
      expiresIn: this.tokens.accessTokenTtlSeconds,
    };
  }

  private async currentContext(
    userId: string,
    organizationId: string,
  ): Promise<AuthContext | null> {
    const membership = await this.db.run({ userId, organizationId }, (tx) =>
      tx.membership.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: { role: true },
      }),
    );
    return membership ? { userId, organizationId, role: membership.role } : null;
  }

  private loadSession(userId: string, organizationId: string): Promise<Session | null> {
    return this.db.run({ userId, organizationId }, async (tx) => {
      const [user, organization, memberships] = await Promise.all([
        tx.user.findUnique({ where: { id: userId } }),
        tx.organization.findUnique({ where: { id: organizationId } }),
        tx.membership.findMany({
          where: { userId },
          include: { organization: { select: { name: true } } },
          orderBy: { createdAt: 'asc' },
        }),
      ]);
      const active = memberships.find((m) => m.organizationId === organizationId);
      if (!user || !organization || !active) return null;
      return {
        user: { id: user.id, email: user.email, fullName: user.fullName },
        organization: toOrganization(organization),
        role: active.role,
        memberships: memberships.map((m) => ({
          organizationId: m.organizationId,
          organizationName: m.organization.name,
          role: m.role,
        })),
      };
    });
  }

  /** Stores the hash of a new opaque refresh token and returns the token (shown once). */
  private async createRefreshToken(
    tx: Tx,
    input: { userId: string; organizationId: string; familyId: string },
  ): Promise<{ id: string; token: string }> {
    const token = generateOpaqueToken();
    const id = newId();
    await tx.refreshToken.create({
      data: {
        id,
        userId: input.userId,
        organizationId: input.organizationId,
        familyId: input.familyId,
        tokenHash: hashToken(token),
        expiresAt: new Date(this.now() + this.tokens.refreshTokenTtlMs),
      },
    });
    return { id, token };
  }

  private async revokeFamily(
    familyId: string,
    now: number,
    audit?: { organizationId: string; userId: string; action: string; ip: string | null },
  ): Promise<void> {
    const context = audit ? { organizationId: audit.organizationId, userId: audit.userId } : {};
    await this.db.run(context, async (tx) => {
      await tx.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date(now) },
      });
      if (audit) {
        await recordAudit(tx, {
          organizationId: audit.organizationId,
          actorUserId: audit.userId,
          action: audit.action,
          ip: audit.ip,
        });
      }
    });
  }
}
