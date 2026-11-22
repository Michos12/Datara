import { stringify } from 'csv-stringify/sync';
import { rm } from 'node:fs/promises';
import { AppError } from '../../core/errors.js';
import type { AuthContext } from '../../core/request-context.js';
import { raw, recordDataChange, sql, type Database, type Tx } from '../../infra/database.js';
import { enqueueJob, type ClaimedJob } from '../../infra/job-queue.js';
import type { FileStorage } from '../../infra/storage.js';
import { ZipWriter } from '../../infra/zip.js';
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

/** A table in the organization export. Identifiers are fixed here, never user input. */
interface ExportTable {
  file: string;
  table: string;
  columns: readonly string[];
}

const EXPORT_TABLES: readonly ExportTable[] = [
  {
    file: 'customers.csv',
    table: 'customers',
    columns: [
      'id',
      'external_id',
      'first_name',
      'last_name',
      'email',
      'phone',
      'country',
      'region',
      'city',
      'registered_at',
      'tags',
      'attributes',
      'marketing_consent',
      'anonymized_at',
      'deleted_at',
      'created_at',
    ],
  },
  {
    file: 'orders.csv',
    table: 'orders',
    columns: [
      'id',
      'external_id',
      'customer_id',
      'ordered_at',
      'status',
      'channel',
      'gross_cents',
      'discount_cents',
      'tax_cents',
      'refunded_cents',
      'net_cents',
      'deleted_at',
      'created_at',
    ],
  },
  {
    file: 'order_items.csv',
    table: 'order_items',
    columns: ['id', 'order_id', 'product_id', 'sku', 'name', 'quantity', 'unit_price_cents'],
  },
  {
    file: 'interactions.csv',
    table: 'interactions',
    columns: [
      'id',
      'external_id',
      'customer_id',
      'type',
      'channel',
      'occurred_at',
      'metadata',
      'created_at',
    ],
  },
  {
    file: 'segment_configs.csv',
    table: 'segment_configs',
    columns: ['id', 'version', 'is_active', 'config', 'created_at'],
  },
  {
    file: 'audit_log.csv',
    table: 'audit_logs',
    columns: ['id', 'created_at', 'action', 'actor_user_id', 'entity_type', 'entity_id', 'details'],
  },
];

const EXPORT_BATCH_ROWS = 5_000;
/** An export holds one connection for its snapshot; 1.2M orders take well under a minute. */
const EXPORT_TIMEOUT_MS = 15 * 60_000;
const EXPORT_README =
  'Customer Insights data export.\r\nMoney columns ending in _cents are integer minor units of the organization currency.\r\nTimestamps are UTC (ISO 8601). Rows are in creation order (by id).\r\n';

function csvCellValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') return JSON.stringify(v);
  return neutralizeFormula(String(v));
}

/** One CSV chunk; the first carries the BOM and the header row. */
function csvChunk(
  rows: Record<string, unknown>[],
  columns: readonly string[],
  first: boolean,
): Buffer {
  const body = stringify(
    rows.map((r) => columns.map((c) => csvCellValue(r[c]))),
    { header: first, columns: [...columns], bom: first, record_delimiter: 'windows' },
  );
  return Buffer.from(body, 'utf8');
}

/** The organization's rows of one table as CSV chunks, in keyset pages by id. */
async function* csvPages(tx: Tx, org: string, t: ExportTable): AsyncGenerator<Buffer> {
  let after: string | null = null;
  for (let first = true; ; first = false) {
    const rows: Record<string, unknown>[] = await tx.$queryRaw<Record<string, unknown>[]>(sql`
      SELECT ${raw(t.columns.join(', '))} FROM ${raw(t.table)}
      WHERE organization_id = ${org}::uuid AND (${after}::uuid IS NULL OR id > ${after}::uuid)
      ORDER BY id LIMIT ${EXPORT_BATCH_ROWS}`);
    if (first || rows.length > 0) yield csvChunk(rows, t.columns, first);
    if (rows.length < EXPORT_BATCH_ROWS) return;
    after = String(rows[rows.length - 1]!.id);
  }
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

  /**
   * Job handler: every table of the organization as CSV, in one ZIP. The tables are read in
   * pages inside one snapshot transaction and streamed into the archive on disk, so memory stays
   * flat and the export is consistent at any size.
   */
  async generateExport(job: ClaimedJob): Promise<void> {
    const org = job.organizationId;
    if (!org) throw new Error('export job needs an organization');
    const fileKey = `exports/${org}/${job.id}.zip`;
    await this.storage.ensureDir(fileKey);
    const out = this.storage.createWriteStream(fileKey);
    const zip = new ZipWriter(out, new Date(this.now()));
    let bytes: number;
    try {
      bytes = await this.db.run(
        { organizationId: org },
        async (tx) => {
          await zip.add('README.txt', [Buffer.from(EXPORT_README)]);
          const organization = await tx.$queryRaw<Record<string, unknown>[]>`
            SELECT id, name, slug, timezone, currency, industry, settings, created_at
            FROM organizations WHERE id = ${org}::uuid`;
          await zip.add('organization.json', [
            Buffer.from(JSON.stringify(organization[0] ?? {}, null, 2)),
          ]);
          for (const table of EXPORT_TABLES) await zip.add(table.file, csvPages(tx, org, table));
          return zip.finish();
        },
        { timeoutMs: EXPORT_TIMEOUT_MS, snapshot: true },
      );
    } catch (err) {
      out.destroy();
      await this.storage.remove(fileKey);
      throw err;
    }
    const fileName = `customer-insights-export-${new Date(this.now()).toISOString().slice(0, 10)}.zip`;
    await this.db.run(
      { organizationId: org },
      (tx) =>
        tx.$executeRaw`UPDATE jobs SET result = ${JSON.stringify({ fileKey, fileName, bytes })}::jsonb
        WHERE id = ${job.id}::uuid`,
    );
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
