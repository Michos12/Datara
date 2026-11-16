import type { AuditLogPage, Organization, UpdateOrganizationRequest } from '@ci/contracts';
import { AppError } from '../../core/errors.js';
import type { AuthContext } from '../../core/request-context.js';
import { recordDataChange, type Database } from '../../infra/database.js';
import { listAudit, recordAudit } from '../audit/audit.service.js';
import { toOrganization } from './organization.mapper.js';

export class OrganizationService {
  constructor(private readonly db: Database) {}

  async get(auth: AuthContext): Promise<Organization> {
    const row = await this.db.run(auth, (tx) =>
      tx.organization.findUnique({ where: { id: auth.organizationId } }),
    );
    if (!row) throw new AppError('NOT_FOUND', 'Organization not found');
    return toOrganization(row);
  }

  async update(
    auth: AuthContext,
    input: UpdateOrganizationRequest,
    ip: string | null,
  ): Promise<Organization> {
    return this.db.run(auth, async (tx) => {
      const current = await tx.organization.findUnique({ where: { id: auth.organizationId } });
      if (!current) throw new AppError('NOT_FOUND', 'Organization not found');
      const before = toOrganization(current);

      const updated = await tx.organization.update({
        where: { id: auth.organizationId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.industry !== undefined ? { industry: input.industry } : {}),
          ...(input.settings !== undefined ? { settings: input.settings } : {}),
        },
      });
      const after = toOrganization(updated);

      const changed = (['name', 'timezone', 'industry', 'settings'] as const).filter(
        (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
      );
      // Time zone and thresholds change every analytics result: recompute right away.
      if (changed.some((key) => key === 'timezone' || key === 'settings')) {
        await recordDataChange(tx, auth.organizationId, { delayMs: 0, trigger: 'settings' });
      }
      if (changed.length > 0) {
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.userId,
          action: 'organization.update',
          entityType: 'organization',
          entityId: auth.organizationId,
          details: Object.fromEntries(
            changed.map((key) => [key, { from: before[key], to: after[key] }]),
          ),
          ip,
        });
      }
      return after;
    });
  }

  auditLog(
    auth: AuthContext,
    page: { limit: number; cursor?: string | undefined },
  ): Promise<AuditLogPage> {
    return this.db.run(auth, (tx) => listAudit(tx, auth.organizationId, page));
  }
}
