import { once } from 'node:events';
import type { ImportEntity, ImportOptions, ImportRowError } from '@ci/contracts';
import { stringify } from 'csv-stringify';
import type { Logger } from '../../core/logger.js';
import {
  recordDataChange,
  join,
  raw,
  sql,
  type Database,
  type SqlFragment,
  type Tx,
} from '../../infra/database.js';
import type { HandlerRegistry } from '../../infra/job-dispatch.js';
import type { ClaimedJob } from '../../infra/job-queue.js';
import type { FileStorage } from '../../infra/storage.js';
import { recordAudit } from '../audit/audit.service.js';
import { newId } from '../../core/ids.js';
import { readCsv } from './csv.js';
import { readStoredMapping } from './import.mapper.js';
import { IMPORT_JOBS } from './import.service.js';
import {
  parseRow,
  type MappedRow,
  type ParseContext,
  type ParsedCustomer,
  type ParsedOrder,
  type RowError,
} from './parsing.js';

const BATCH_SIZE = 1000;
const ERROR_SAMPLE_SIZE = 50;

export interface ImportJobDeps {
  db: Database;
  storage: FileStorage;
  now?: () => number;
}

export function importJobHandlers(deps: ImportJobDeps): HandlerRegistry {
  return {
    [IMPORT_JOBS.validate]: (job, { logger }) => runSafely(deps, job, logger, validateImport),
    [IMPORT_JOBS.commit]: (job, { logger }) => runSafely(deps, job, logger, commitImport),
  };
}

type Step = (deps: ImportJobDeps, ctx: ImportContext) => Promise<void>;

interface ImportContext {
  organizationId: string;
  importId: string;
  entity: ImportEntity;
  fileKey: string;
  delimiter: string;
  mapping: Record<string, string | null>;
  parse: ParseContext;
}

/**
 * Problems with the file itself (malformed CSV, missing mapping) are permanent: the import is
 * marked FAILED with a readable reason and the job is not retried.
 */
async function runSafely(deps: ImportJobDeps, job: ClaimedJob, logger: Logger, step: Step) {
  const importId = (job.payload as { importId?: string }).importId;
  if (!job.organizationId || !importId)
    throw new Error('Import job without organization or import ID');
  const ctx = await loadContext(deps, job.organizationId, importId);
  try {
    await step(deps, ctx);
  } catch (err) {
    logger.error({ err, importId }, 'import step failed');
    await deps.db.run({ organizationId: ctx.organizationId }, (tx) =>
      tx.import.update({
        where: { id: importId },
        data: {
          status: 'FAILED',
          failureReason: err instanceof Error ? err.message.slice(0, 500) : 'Unexpected error',
          finishedAt: new Date(),
        },
      }),
    );
  }
}

async function loadContext(
  deps: ImportJobDeps,
  organizationId: string,
  importId: string,
): Promise<ImportContext> {
  const now = deps.now ?? Date.now;
  return deps.db.run({ organizationId }, async (tx) => {
    const [row, org] = await Promise.all([
      tx.import.findFirst({ where: { id: importId, organizationId } }),
      tx.organization.findUnique({ where: { id: organizationId } }),
    ]);
    if (!row || !org) throw new Error(`Import ${importId} not found`);
    const stored = readStoredMapping(row.mapping);
    if (!stored.mapping || !stored.options) throw new Error('Import has no column mapping');
    return {
      organizationId,
      importId,
      entity: row.entity.toLowerCase() as ImportEntity,
      fileKey: row.fileKey,
      delimiter: stored.delimiter,
      mapping: stored.mapping,
      parse: {
        options: stored.options as ImportOptions,
        timeZone: org.timezone,
        currency: org.currency.trim(),
        latestOrderAt: now() + 24 * 60 * 60 * 1000,
      },
    };
  });
}

function mapRow(values: Record<string, string>, mapping: Record<string, string | null>): MappedRow {
  const row: MappedRow = {};
  for (const [field, column] of Object.entries(mapping)) {
    if (column) row[field] = values[column] ?? '';
  }
  return row;
}

async function customerIdsByExternalId(
  tx: Tx,
  organizationId: string,
): Promise<Map<string, string>> {
  const rows = await tx.$queryRaw<{ id: string; external_id: string }[]>`
    SELECT id, external_id FROM customers
    WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL AND external_id IS NOT NULL`;
  return new Map(rows.map((r) => [r.external_id, r.id]));
}

type Checked =
  | { ok: true; value: ParsedCustomer | ParsedOrder; line: number }
  | { ok: false; errors: RowError[]; line: number };

/**
 * Parses and cross-checks every row: field values, duplicate IDs inside the file, and (for
 * orders) that the customer exists. Shared by validation and commit so both agree exactly.
 */
async function* checkedRows(
  deps: ImportJobDeps,
  ctx: ImportContext,
  knownCustomers: Map<string, string> | null,
): AsyncGenerator<Checked> {
  const seen = new Set<string>();
  for await (const record of readCsv(deps.storage.read(ctx.fileKey), ctx.delimiter)) {
    const result = parseRow(ctx.entity, mapRow(record.values, ctx.mapping), ctx.parse);
    if (!result.ok) {
      yield { ok: false, errors: result.errors, line: record.line };
      continue;
    }
    const errors: RowError[] = [];
    if (seen.has(result.value.externalId)) {
      errors.push({
        field: 'externalId',
        message: `"${result.value.externalId}" appears more than once in the file`,
      });
    }
    seen.add(result.value.externalId);
    if (knownCustomers && 'customerExternalId' in result.value) {
      const customer = result.value.customerExternalId;
      if (customer && !knownCustomers.has(customer)) {
        errors.push({
          field: 'customerExternalId',
          message: `No customer with ID "${customer}". Import customers first.`,
        });
      }
    }
    yield errors.length > 0
      ? { ok: false, errors, line: record.line }
      : { ok: true, value: result.value, line: record.line };
  }
}

async function validateImport(deps: ImportJobDeps, ctx: ImportContext): Promise<void> {
  const known =
    ctx.entity === 'orders'
      ? await deps.db.run({ organizationId: ctx.organizationId }, (tx) =>
          customerIdsByExternalId(tx, ctx.organizationId),
        )
      : null;

  const errorKey = `imports/${ctx.organizationId}/${ctx.importId}.errors.csv`;
  await deps.storage.ensureDir(errorKey);
  const out = deps.storage.createWriteStream(errorKey);
  const csv = stringify({ header: true, columns: ['line', 'field', 'message'], bom: true });
  csv.pipe(out);

  let total = 0;
  let valid = 0;
  let failed = 0;
  const sample: ImportRowError[] = [];
  for await (const row of checkedRows(deps, ctx, known)) {
    total++;
    if (row.ok) {
      valid++;
      continue;
    }
    failed++;
    for (const error of row.errors) {
      if (!csv.write([row.line, error.field ?? '', error.message])) await once(csv, 'drain');
      if (sample.length < ERROR_SAMPLE_SIZE) sample.push({ line: row.line, ...error });
    }
  }
  csv.end();
  await once(out, 'close');
  if (failed === 0) await deps.storage.remove(errorKey);

  await deps.db.run({ organizationId: ctx.organizationId }, (tx) =>
    tx.import.update({
      where: { id: ctx.importId },
      data: {
        status: 'VALIDATED',
        rowsTotal: total,
        rowsValid: valid,
        rowsFailed: failed,
        errorSample: sample,
        errorFileKey: failed > 0 ? errorKey : null,
      },
    }),
  );
}

async function commitImport(deps: ImportJobDeps, ctx: ImportContext): Promise<void> {
  const db = deps.db;
  const scope = { organizationId: ctx.organizationId };
  const known =
    ctx.entity === 'orders'
      ? await db.run(scope, (tx) => customerIdsByExternalId(tx, ctx.organizationId))
      : null;

  let inserted = 0;
  let updated = 0;
  let failed = 0;
  let batch: (ParsedCustomer | ParsedOrder)[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const rows = batch;
    batch = [];
    const result = await db.run(scope, (tx) =>
      ctx.entity === 'customers'
        ? upsertCustomers(tx, ctx, rows as ParsedCustomer[])
        : upsertOrders(tx, ctx, rows as ParsedOrder[], known!),
    );
    inserted += result.inserted;
    updated += result.updated;
  };

  for await (const row of checkedRows(deps, ctx, known)) {
    if (!row.ok) {
      failed++;
      continue;
    }
    batch.push(row.value);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  await db.run(scope, async (tx) => {
    await recordDataChange(tx, ctx.organizationId, { delayMs: 0, trigger: 'import' });
    const record = await tx.import.update({
      where: { id: ctx.importId },
      data: {
        status: 'COMPLETED',
        rowsInserted: inserted,
        rowsUpdated: updated,
        rowsFailed: failed,
        finishedAt: new Date(),
      },
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: record.createdById,
      action: 'import.commit',
      entityType: 'import',
      entityId: ctx.importId,
      details: {
        entity: ctx.entity,
        inserted,
        updated,
        skipped: failed,
        file: record.originalName,
      },
    });
  });
}

// ───────────── bulk upserts ─────────────

/** Column, SQL cast, and how to read the value, for each importable customer field. */
const CUSTOMER_COLUMNS: Record<string, { column: string; cast: string }> = {
  firstName: { column: 'first_name', cast: 'text' },
  lastName: { column: 'last_name', cast: 'text' },
  email: { column: 'email', cast: 'citext' },
  phone: { column: 'phone', cast: 'text' },
  country: { column: 'country', cast: 'char(2)' },
  region: { column: 'region', cast: 'text' },
  city: { column: 'city', cast: 'text' },
  registeredAt: { column: 'registered_at', cast: 'date' },
  tags: { column: 'tags', cast: 'text[]' },
  marketingConsent: { column: 'marketing_consent', cast: 'boolean' },
};

async function countInserted(
  tx: Tx,
  statement: SqlFragment,
): Promise<{ inserted: number; updated: number }> {
  // xmax = 0 on a returned row means it was inserted rather than updated by ON CONFLICT.
  const rows = await tx.$queryRaw<
    { inserted: boolean }[]
  >`${statement} RETURNING (xmax = 0) AS inserted`;
  const inserted = rows.filter((r) => r.inserted).length;
  return { inserted, updated: rows.length - inserted };
}

/**
 * Inserts new customers and updates existing ones (same external ID). Only mapped columns are
 * written, so re-importing a partial file never blanks out other fields.
 */
function upsertCustomers(tx: Tx, ctx: ImportContext, rows: ParsedCustomer[]) {
  const fields = Object.keys(CUSTOMER_COLUMNS).filter((key) => ctx.mapping[key]);
  const columns = [
    'id',
    'organization_id',
    'external_id',
    ...fields.map((f) => CUSTOMER_COLUMNS[f]!.column),
    'updated_at',
  ];
  const values = rows.map((row) => {
    const record = row as unknown as Record<string, unknown>;
    const cells = [
      sql`${newId()}::uuid`,
      sql`${ctx.organizationId}::uuid`,
      sql`${row.externalId}`,
      ...fields.map((f) => sql`${record[f] ?? null}::${raw(CUSTOMER_COLUMNS[f]!.cast)}`),
      sql`now()`,
    ];
    return sql`(${join(cells, ', ')})`;
  });
  const updates = [
    ...fields.map(
      (f) => `${CUSTOMER_COLUMNS[f]!.column} = EXCLUDED.${CUSTOMER_COLUMNS[f]!.column}`,
    ),
    'updated_at = now()',
  ];
  return countInserted(
    tx,
    sql`INSERT INTO customers (${raw(columns.join(', '))}) VALUES ${join(values, ', ')}
        ON CONFLICT (organization_id, external_id) DO UPDATE SET ${raw(updates.join(', '))}`,
  );
}

/**
 * Inserts or updates orders by external ID. Amounts are always replaced (unmapped amount
 * columns mean zero); optional descriptive columns are only written when mapped.
 */
function upsertOrders(
  tx: Tx,
  ctx: ImportContext,
  rows: ParsedOrder[],
  customers: Map<string, string>,
) {
  const values = rows.map(
    (row) => sql`(${newId()}::uuid, ${ctx.organizationId}::uuid, ${row.externalId},
      ${row.customerExternalId ? (customers.get(row.customerExternalId) ?? null) : null}::uuid,
      ${row.orderedAt}::timestamptz, ${row.status.toUpperCase()}::"OrderStatus", ${row.channel}::text,
      ${row.grossCents}::bigint, ${row.discountCents}::bigint, ${row.taxCents}::bigint,
      ${row.refundedCents}::bigint, now())`,
  );
  const updates = [
    'ordered_at = EXCLUDED.ordered_at',
    'gross_cents = EXCLUDED.gross_cents',
    'discount_cents = EXCLUDED.discount_cents',
    'tax_cents = EXCLUDED.tax_cents',
    'refunded_cents = EXCLUDED.refunded_cents',
    'updated_at = now()',
  ];
  if (ctx.mapping.customerExternalId) updates.push('customer_id = EXCLUDED.customer_id');
  if (ctx.mapping.status) updates.push('status = EXCLUDED.status');
  if (ctx.mapping.channel) updates.push('channel = EXCLUDED.channel');
  return countInserted(
    tx,
    sql`INSERT INTO orders (id, organization_id, external_id, customer_id, ordered_at, status, channel,
                            gross_cents, discount_cents, tax_cents, refunded_cents, updated_at)
        VALUES ${join(values, ', ')}
        ON CONFLICT (organization_id, external_id) DO UPDATE SET ${raw(updates.join(', '))}`,
  );
}
