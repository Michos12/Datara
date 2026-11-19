import {
  INVITATION_TTL_DAYS,
  type CreateInvitationRequest,
  type Invitation,
  type Member,
  type Role,
} from '@ci/contracts';
import { AppError } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import type { Logger } from '../../core/logger.js';
import type { AuthContext } from '../../core/request-context.js';
import type { Database, Tx } from '../../infra/database.js';
import type { Mailer } from '../../infra/mailer.js';
import { recordAudit } from '../audit/audit.service.js';
import { invitationEmail } from '../auth/emails.js';
import { generateOpaqueToken, hashToken } from '../auth/tokens.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Members and invitations of the active organization (AUTH-04). Owners manage everyone;
 * admins manage everyone except owners and cannot create owners. An organization always
 * keeps at least one owner.
 */
export class TeamService {
  constructor(
    private readonly db: Database,
    private readonly mail: { mailer: Mailer; appUrl: string; logger: Logger },
    private readonly now: () => number = Date.now,
  ) {}

  async members(auth: AuthContext): Promise<Member[]> {
    const rows = await this.db.run(auth, (tx) =>
      tx.membership.findMany({
        where: { organizationId: auth.organizationId },
        include: { user: { select: { email: true, fullName: true, lastLoginAt: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      fullName: m.user.fullName,
      role: m.role,
      joinedAt: m.createdAt.toISOString(),
      lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
    }));
  }

  async updateRole(auth: AuthContext, userId: string, role: Role, ip: string | null) {
    return this.db.run(auth, async (tx) => {
      const member = await this.member(tx, auth.organizationId, userId);
      this.assertCanManage(auth, member.role, role);
      if (member.role === 'OWNER' && role !== 'OWNER') await this.assertOtherOwner(tx, auth);
      await tx.membership.update({ where: { id: member.id }, data: { role } });
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'member.role',
        entityType: 'user',
        entityId: userId,
        details: { from: member.role, to: role },
        ip,
      });
    });
  }

  async remove(auth: AuthContext, userId: string, ip: string | null): Promise<void> {
    await this.db.run(auth, async (tx) => {
      const member = await this.member(tx, auth.organizationId, userId);
      if (userId !== auth.userId) this.assertCanManage(auth, member.role, member.role);
      if (member.role === 'OWNER') await this.assertOtherOwner(tx, auth);
      await tx.membership.delete({ where: { id: member.id } });
      // Their sessions in this organization end at the next refresh; revoke them now.
      await tx.refreshToken.updateMany({
        where: { userId, organizationId: auth.organizationId, revokedAt: null },
        data: { revokedAt: new Date(this.now()) },
      });
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'member.remove',
        entityType: 'user',
        entityId: userId,
        details: { role: member.role, self: userId === auth.userId },
        ip,
      });
    });
  }

  async invitations(auth: AuthContext): Promise<Invitation[]> {
    const rows = await this.db.run(auth, (tx) =>
      tx.invitation.findMany({
        where: {
          organizationId: auth.organizationId,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date(this.now()) },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    const inviters = await this.inviterNames(rows.map((r) => r.invitedById));
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      invitedBy: r.invitedById ? (inviters.get(r.invitedById) ?? null) : null,
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Creates (or re-sends, replacing the pending one) an invitation and emails its link. */
  async invite(
    auth: AuthContext,
    input: CreateInvitationRequest,
    ip: string | null,
  ): Promise<Invitation> {
    this.assertCanManage(auth, input.role, input.role);
    const token = generateOpaqueToken();
    const now = new Date(this.now());
    const { row, organizationName } = await this.db.run(auth, async (tx) => {
      const already = await tx.membership.findFirst({
        where: { organizationId: auth.organizationId, user: { email: input.email } },
      });
      if (already) throw new AppError('CONFLICT', 'This person is already a member');
      await tx.invitation.updateMany({
        where: {
          organizationId: auth.organizationId,
          email: input.email,
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      const row = await tx.invitation.create({
        data: {
          id: newId(),
          organizationId: auth.organizationId,
          email: input.email,
          role: input.role,
          tokenHash: hashToken(token),
          invitedById: auth.userId,
          expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * DAY_MS),
        },
      });
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'invitation.create',
        entityType: 'invitation',
        entityId: row.id,
        details: { role: input.role },
        ip,
      });
      const org = await tx.organization.findUniqueOrThrow({ where: { id: auth.organizationId } });
      return { row, organizationName: org.name };
    });

    const inviter = (await this.inviterNames([auth.userId])).get(auth.userId) ?? null;
    let emailSent = true;
    try {
      await this.mail.mailer.send(
        invitationEmail({
          to: input.email,
          link: `${this.mail.appUrl}/invitation#token=${token}`,
          organizationName,
          inviterName: inviter,
          role: input.role,
          days: INVITATION_TTL_DAYS,
        }),
      );
    } catch (err) {
      emailSent = false;
      this.mail.logger.error({ err }, 'invitation email failed');
    }
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      invitedBy: inviter,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      emailSent,
    };
  }

  async revoke(auth: AuthContext, id: string, ip: string | null): Promise<void> {
    await this.db.run(auth, async (tx) => {
      const { count } = await tx.invitation.updateMany({
        where: { id, organizationId: auth.organizationId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date(this.now()) },
      });
      if (count === 0) throw new AppError('NOT_FOUND', 'Invitation not found');
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'invitation.revoke',
        entityType: 'invitation',
        entityId: id,
        ip,
      });
    });
  }

  // ───────────── helpers ─────────────

  private async member(tx: Tx, organizationId: string, userId: string) {
    const member = await tx.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    if (!member) throw new AppError('NOT_FOUND', 'Member not found');
    return member;
  }

  /** Admins can neither touch owners nor make anyone an owner. */
  private assertCanManage(auth: AuthContext, current: Role, next: Role): void {
    if (auth.role === 'OWNER') return;
    if (current === 'OWNER' || next === 'OWNER') {
      throw new AppError('FORBIDDEN', 'Only owners can manage owners');
    }
  }

  private async assertOtherOwner(tx: Tx, auth: AuthContext): Promise<void> {
    const owners = await tx.membership.count({
      where: { organizationId: auth.organizationId, role: 'OWNER' },
    });
    if (owners <= 1) {
      throw new AppError('CONFLICT', 'The organization needs at least one other owner first');
    }
  }

  private async inviterNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) return new Map();
    const users = await this.db.run({}, (tx) =>
      tx.user.findMany({ where: { id: { in: wanted } }, select: { id: true, fullName: true } }),
    );
    return new Map(users.map((u) => [u.id, u.fullName]));
  }
}
