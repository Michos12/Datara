import { randomBytes } from 'node:crypto';
import {
  INDUSTRY_PRESETS,
  PASSWORD_RESET_TTL_MINUTES,
  passwordSchema,
  type AcceptInvitationRequest,
  type AuthResponse,
  type InvitationPreview,
  type LoginRequest,
  type RefreshResponse,
  type Session,
  type SignupRequest,
} from '@ci/contracts';
import { AppError } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import type { AuthContext } from '../../core/request-context.js';
import { isUniqueViolation, type Database, type Tx } from '../../infra/database.js';
import type { Logger } from '../../core/logger.js';
import type { Mailer } from '../../infra/mailer.js';
import { passwordResetEmail } from './emails.js';
import { recordAudit } from '../audit/audit.service.js';
import { seedSegmentConfig } from '../segments/segment.service.js';
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
const INVALID_LINK = 'This link is invalid or has expired';

/** Optional collaborators for emails; without them, forgot-password sends nothing. */
export interface AuthMail {
  mailer: Mailer;
  appUrl: string;
  logger: Logger;
}
const SESSION_EXPIRED = 'Session expired. Please sign in again.';

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly tokens: TokenService,
    private readonly now: () => number = Date.now,
    private readonly mail: AuthMail | null = null,
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
        await seedSegmentConfig(tx, organizationId, userId);
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

  // ───────────── organization switching (AUTH-05) ─────────────

  /**
   * Moves the session to another organization the user belongs to: a new refresh-token family
   * for that organization replaces the current one, so a refresh can never drift back.
   */
  async switchOrganization(
    auth: AuthContext,
    organizationId: string,
    presented: string | null,
    ip: string | null,
  ): Promise<IssuedSession> {
    const ctx = await this.currentContext(auth.userId, organizationId);
    if (!ctx) throw new AppError('FORBIDDEN', 'You are not a member of this organization');
    if (presented) {
      const stored = await this.db.run({}, (tx) =>
        tx.refreshToken.findUnique({ where: { tokenHash: hashToken(presented) } }),
      );
      if (stored && stored.userId === auth.userId) {
        await this.revokeFamily(stored.familyId, this.now());
      }
    }
    const refreshToken = await this.db.run(ctx, async (tx) => {
      await recordAudit(tx, {
        organizationId,
        actorUserId: auth.userId,
        action: 'auth.switch_organization',
        details: { from: auth.organizationId },
        ip,
      });
      const { token } = await this.createRefreshToken(tx, { ...ctx, familyId: newId() });
      return token;
    });
    return { refreshToken, response: await this.withAccessToken(ctx) };
  }

  // ───────────── password reset (AUTH-06) ─────────────

  /**
   * Emails a single-use reset link when the account exists. The caller always answers 202, so
   * the response never reveals whether an email is registered.
   */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.db.run({}, (tx) => tx.user.findUnique({ where: { email } }));
    if (!user || !this.mail) return;
    const token = generateOpaqueToken();
    await this.db.run({}, async (tx) => {
      // Only the newest link works.
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date(this.now()) },
      });
      await tx.passwordResetToken.create({
        data: {
          id: newId(),
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(this.now() + PASSWORD_RESET_TTL_MINUTES * 60_000),
        },
      });
    });
    // The token travels in the fragment, which browsers never send to servers or in Referer.
    const link = `${this.mail.appUrl}/reset-password#token=${token}`;
    try {
      await this.mail.mailer.send(passwordResetEmail(user.email, link, PASSWORD_RESET_TTL_MINUTES));
    } catch (err) {
      this.mail.logger.error({ err }, 'password reset email failed');
    }
  }

  /** Sets a new password from a reset link and signs the user out everywhere. */
  async resetPassword(token: string, newPassword: string, ip: string | null): Promise<void> {
    const now = new Date(this.now());
    const stored = await this.db.run({}, (tx) =>
      tx.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } }),
    );
    if (!stored || stored.usedAt || stored.expiresAt <= now) {
      throw new AppError('BAD_REQUEST', INVALID_LINK);
    }
    const passwordHash = await hashPassword(newPassword);
    await this.db.run({ userId: stored.userId }, async (tx) => {
      // Conditional: a link used twice at the same moment succeeds only once.
      const { count } = await tx.passwordResetToken.updateMany({
        where: { id: stored.id, usedAt: null },
        data: { usedAt: now },
      });
      if (count !== 1) throw new AppError('BAD_REQUEST', INVALID_LINK);
      await tx.user.update({ where: { id: stored.userId }, data: { passwordHash } });
      await tx.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: now },
      });
    });
    const memberships = await this.db.run({ userId: stored.userId }, (tx) =>
      tx.membership.findMany({
        where: { userId: stored.userId },
        select: { organizationId: true },
      }),
    );
    for (const m of memberships) {
      await this.db.run({ organizationId: m.organizationId }, (tx) =>
        recordAudit(tx, {
          organizationId: m.organizationId,
          actorUserId: stored.userId,
          action: 'auth.password_reset',
          ip,
        }),
      );
    }
  }

  // ───────────── invitations (AUTH-04) ─────────────

  private async findInvitation(token: string) {
    const tokenHash = hashToken(token);
    const invitation = await this.db.run({ invitationTokenHash: tokenHash }, (tx) =>
      tx.invitation.findUnique({ where: { tokenHash } }),
    );
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt.getTime() <= this.now()
    ) {
      throw new AppError('BAD_REQUEST', 'This invitation is invalid, used or expired');
    }
    return invitation;
  }

  async previewInvitation(token: string): Promise<InvitationPreview> {
    const invitation = await this.findInvitation(token);
    const [organization, user] = await Promise.all([
      this.db.run({ organizationId: invitation.organizationId }, (tx) =>
        tx.organization.findUnique({ where: { id: invitation.organizationId } }),
      ),
      this.db.run({}, (tx) => tx.user.findUnique({ where: { email: invitation.email } })),
    ]);
    return {
      organizationName: organization?.name ?? '',
      email: invitation.email,
      role: invitation.role,
      accountExists: user !== null,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /**
   * Joins the invited organization. An existing account proves itself with its password; a new
   * account is created with the given name and password. Either way the session starts in the
   * invited organization.
   */
  async acceptInvitation(
    input: AcceptInvitationRequest,
    ip: string | null,
  ): Promise<IssuedSession> {
    const invitation = await this.findInvitation(input.token);
    const existing = await this.db.run({}, (tx) =>
      tx.user.findUnique({ where: { email: invitation.email } }),
    );
    let userId: string;
    let newUser: { passwordHash: string; fullName: string } | null = null;
    if (existing) {
      if (!(await verifyPassword(existing.passwordHash, input.password))) {
        throw new AppError('UNAUTHENTICATED', 'Wrong password for this account');
      }
      userId = existing.id;
    } else {
      const errors: { path: string; message: string }[] = [];
      if (!input.fullName) errors.push({ path: 'fullName', message: 'Required' });
      const password = passwordSchema.safeParse(input.password);
      if (!password.success) {
        errors.push({ path: 'password', message: password.error.issues[0]!.message });
      }
      if (errors.length > 0) throw new AppError('VALIDATION_FAILED', 'Check the form', errors);
      userId = newId();
      newUser = { passwordHash: await hashPassword(input.password), fullName: input.fullName! };
    }

    const ctx: AuthContext = {
      userId,
      organizationId: invitation.organizationId,
      role: invitation.role,
    };
    const refreshToken = await this.db.run(
      { ...ctx, invitationTokenHash: invitation.tokenHash },
      async (tx) => {
        const { count } = await tx.invitation.updateMany({
          where: { id: invitation.id, acceptedAt: null, revokedAt: null },
          data: { acceptedAt: new Date(this.now()) },
        });
        if (count !== 1) throw new AppError('BAD_REQUEST', 'This invitation was already used');
        if (newUser) {
          await tx.user.create({ data: { id: userId, email: invitation.email, ...newUser } });
        }
        const member = await tx.membership.findUnique({
          where: { organizationId_userId: { organizationId: invitation.organizationId, userId } },
        });
        if (member) throw new AppError('CONFLICT', 'You are already a member of this organization');
        await tx.membership.create({
          data: {
            id: newId(),
            organizationId: invitation.organizationId,
            userId,
            role: invitation.role,
          },
        });
        await recordAudit(tx, {
          organizationId: invitation.organizationId,
          actorUserId: userId,
          action: 'invitation.accept',
          entityType: 'invitation',
          entityId: invitation.id,
          details: { role: invitation.role, newAccount: newUser !== null },
          ip,
        });
        const { token } = await this.createRefreshToken(tx, { ...ctx, familyId: newId() });
        return token;
      },
    );
    return { refreshToken, response: await this.withAccessToken(ctx) };
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
