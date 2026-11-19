import { stringify } from 'csv-stringify/sync';
import { rm } from 'node:fs/promises';
import { AppError } from '../../core/errors.js';
import type { AuthContext } from '../../core/request-context.js';
import { recordDataChange, type Database, type Tx } from '../../infra/database.js';
import { enqueueJob, type ClaimedJob } from '../../infra/job-queue.js';
import type { FileStorage } from '../../infra/storage.js';
import { createZip } from '../../infra/zip.js';
import { recordAudit } from '../audit/audit.service.js';
import { neutralizeFormula } from '../exports/export.routes.js';

export const ORG_EXPORT_JOB = 'privacy.export';

/** Tables that reference organizations without a cascading foreign key. */
const UNLINKED_TABLES = [
  'analytics_customer_metrics',
  'analytics_period_metrics',
  'analytics_query_cache',
  'analytics_runs',
] as const;

interface ExportJobRow {
  id: string;
  status: string;
  error: string | null;
  result: unknown;
  created_at: Date;
  finished_at: Date | null;
}

function csv(rows: Record<string, unknown>[], columns: string[]): Buffer {
  const cell = (v: unknown) =>
    v === null || v === undefined
      ? ''
      : v instanceof Date
        ? v.toISOString()
        : typeof v === 'bigint'
          ? v.toString()
          : typeof v === 'object'
            ? JSON.stringify(v)
            : neutralizeFormula(String(v));
  const body = stringify(
    rows.map((r) => columns.map((c) => cell(r[c]))),
    { header: true, columns, bom: true, record_delimiter: 'windows' },
  );
  return Buffer.from(body, 'utf8');
}

/**
 * Privacy operations (CUS-10, NFR-PRV-02): erase a customer, export everything an organization
 * stored, and delete an organization with all its data.
 */
export class PrivacyService {
  constructor(
    private readonly db: Database,
    private readonly storage: FileStorage,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Right to erasure. "anonymize" keeps the record (and its orders) for aggregate analytics but
   * removes everything that identifies the person; "delete" removes the record and its
   * interactions, and its orders become guest orders (revenue totals stay correct).
   */
  async eraseCustomer(
    auth: AuthContext,
    id: string,
    mode: 'anonymize' | 'delete',
    ip: string | null,
  ): Promise<void> {
    await this.db.run(auth, async (tx) => {
      const exists = await tx.customer.count({
        where: { id, organizationId: auth.organizationId },
      });
      if (!exists) throw new AppError('NOT_FOUND', 'Customer not found');
      if (mode === 'anonymize') {
        await tx.customer.update({
          where: { id },
          data: {
            externalId: null,
            firstName: null,
            lastName: null,
            email: null,
            phone: null,
            region: null,
            city: null,
            tags: [],
            attributes: {},
            marketingConsent: false,
            anonymizedAt: new Date(this.now()),
          },
        });
        await tx.interaction.updateMany({
          where: { customerId: id, organizationId: auth.organizationId },
          data: { metadata: {}, externalId: null },
        });
      } else {
        await tx.recommendationCustomer.deleteMany({
          where: { customerId: id, organizationId: auth.organizationId },
        });
        await tx.customer.delete({ where: { id } });
      }
      await recordDataChange(tx, auth.organizationId);
      // The audit entry names the customer ID only, never what was erased.
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: `customer.${mode === 'anonymize' ? 'anonymize' : 'erase'}`,
        entityType: 'customer',
        entityId: id,
        ip,
      });
    });
  }

  async requestExport(auth: AuthContext, ip: string | null): Promise<string> {
    return this.db.run(auth, async (tx) => {
      const pending = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM jobs WHERE organization_id = ${auth.organizationId}::uuid
          AND type = ${ORG_EXPORT_JOB} AND status IN ('PENDING', 'RUNNING')`;
      if ((pending[0]?.n ?? 0) > 0) throw new AppError('CONFLICT', 'An export is already running');
      const id = await enqueueJob(tx, {
        type: ORG_EXPORT_JOB,
        organizationId: auth.organizationId,
        payload: { userId: auth.userId },
      });
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'organization.export',
        entityType: 'job',
        entityId: id ?? undefined,
        ip,
      });
      return id!;
    });
  }

  async exportJob(auth: AuthContext, id: string) {
    const rows = await this.db.run(
      auth,
      (tx) => tx.$queryRaw<ExportJobRow[]>`
        SELECT id, status::text AS status, error, result, created_at, finished_at FROM jobs
        WHERE id = ${id}::uuid AND organization_id = ${auth.organizationId}::uuid
          AND type = ${ORG_EXPORT_JOB}`,
    );
    const job = rows[0];
    if (!job) throw new AppError('NOT_FOUND', 'Export not found');
    const result = (job.result ?? {}) as { fileKey?: string; fileName?: string };
    return {
      id: job.id,
      status: job.status.toLowerCase() as 'pending' | 'running' | 'succeeded' | 'failed',
      fileName: result.fileName ?? null,
      fileKey: result.fileKey ?? null,
      error: job.status === 'FAILED' ? (job.error ?? 'Failed') : null,
      createdAt: job.created_at.toISOString(),
      finishedAt: job.finished_at?.toISOString() ?? null,
    };
  }

  /** Job handler: every table of the organization as CSV, in one ZIP. */
  async generateExport(job: ClaimedJob): Promise<void> {
    const org = job.organizationId;
    if (!org) throw new Error('export job needs an organization');
    const files = await this.db.run({ organizationId: org }, (tx) => this.collect(tx, org));
    const zip = createZip(files, new Date(this.now()));
    const fileKey = `exports/${org}/${job.id}.zip`;
    await this.storage.ensureDir(fileKey);
    const out = this.storage.createWriteStream(fileKey);
    await new Promise<void>((resolve, reject) => {
      out.on('error', reject);
      out.end(zip, () => resolve());
    });
    const fileName = `customer-insights-export-${new Date(this.now()).toISOString().slice(0, 10)}.zip`;
    await this.db.run(
      { organizationId: org },
      (tx) =>
        tx.$executeRaw`UPDATE jobs SET result = ${JSON.stringify({ fileKey, fileName, bytes: zip.length })}::jsonb
        WHERE id = ${job.id}::uuid`,
    );
  }

  private async collect(tx: Tx, org: string): Promise<{ name: string; data: Buffer }[]> {
    const q = (sql: TemplateStringsArray) =>
      tx.$queryRawUnsafe<Record<string, unknown>[]>(sql.join(''), org);
    const organization = await q`
      SELECT id, name, slug, timezone, currency, industry, settings, created_at
      FROM organizations WHERE id = $1::uuid`;
    const customers = await q`
      SELECT id, external_id, first_name, last_name, email, phone, country, region, city,
             registered_at, tags, attributes, marketing_consent, anonymized_at, deleted_at, created_at
      FROM customers WHERE organization_id = $1::uuid ORDER BY created_at`;
    const orders = await q`
      SELECT id, external_id, customer_id, ordered_at, status, channel, gross_cents, discount_cents,
             tax_cents, refunded_cents, net_cents, deleted_at, created_at
      FROM orders WHERE organization_id = $1::uuid ORDER BY ordered_at`;
    const items = await q`
      SELECT id, order_id, product_id, sku, name, quantity, unit_price_cents
      FROM order_items WHERE organization_id = $1::uuid`;
    const interactions = await q`
      SELECT id, external_id, customer_id, type, channel, occurred_at, metadata, created_at
      FROM interactions WHERE organization_id = $1::uuid ORDER BY occurred_at`;
    const segments = await q`
      SELECT version, is_active, config, created_at FROM segment_configs
      WHERE organization_id = $1::uuid ORDER BY version`;
    const audit = await q`
      SELECT created_at, action, actor_user_id, entity_type, entity_id, details
      FROM audit_logs WHERE organization_id = $1::uuid ORDER BY created_at`;
    const cols = (rows: Record<string, unknown>[], fallback: string[]) =>
      rows[0] ? Object.keys(rows[0]) : fallback;
    return [
      {
        name: 'README.txt',
        data: Buffer.from(
          'Customer Insights data export.\r\nMoney columns ending in _cents are integer minor units of the organization currency.\r\nTimestamps are UTC (ISO 8601).\r\n',
        ),
      },
      {
        name: 'organization.json',
        data: Buffer.from(JSON.stringify(organization[0] ?? {}, null, 2)),
      },
      { name: 'customers.csv', data: csv(customers, cols(customers, ['id'])) },
      { name: 'orders.csv', data: csv(orders, cols(orders, ['id'])) },
      { name: 'order_items.csv', data: csv(items, cols(items, ['id'])) },
      { name: 'interactions.csv', data: csv(interactions, cols(interactions, ['id'])) },
      { name: 'segment_configs.csv', data: csv(segments, cols(segments, ['version'])) },
      { name: 'audit_log.csv', data: csv(audit, cols(audit, ['created_at'])) },
    ];
  }

  /**
   * Deletes the organization and everything it stored. Owners only, and only after typing the
   * organization's name. Member accounts remain for their other organizations.
   */
  async deleteOrganization(auth: AuthContext, confirmName: string): Promise<void> {
    const org = auth.organizationId;
    await this.db.run(auth, async (tx) => {
      const organization = await tx.organization.findUnique({ where: { id: org } });
      if (!organization) throw new AppError('NOT_FOUND', 'Organization not found');
      if (organization.name.trim() !== confirmName.trim()) {
        throw new AppError('VALIDATION_FAILED', 'Type the organization name to confirm', [
          { path: 'confirmName', message: 'Does not match the organization name' },
        ]);
      }
      for (const table of UNLINKED_TABLES) {
        await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, org);
      }
      await tx.$executeRaw`DELETE FROM jobs WHERE organization_id = ${org}::uuid`;
      // Everything else cascades from the organization row (customers, orders, memberships…).
      await tx.organization.delete({ where: { id: org } });
    });
    for (const dir of ['imports', 'reports', 'exports']) {
      await rm(this.storage.path(`${dir}/${org}`), { recursive: true, force: true });
    }
  }
}
