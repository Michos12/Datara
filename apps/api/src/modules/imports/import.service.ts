import type { Readable } from 'node:stream';
import {
  IMPORT_FIELDS,
  MAX_IMPORT_BYTES,
  suggestMapping,
  type Import,
  type ImportEntity,
  type ImportMappingRequest,
  type ImportOptions,
  type ImportUploadResponse,
} from '@ci/contracts';
import { AppError } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import type { AuthContext } from '../../core/request-context.js';
import type { Database } from '../../infra/database.js';
import { enqueueJob } from '../../infra/job-queue.js';
import type { FileStorage } from '../../infra/storage.js';
import { inspectCsv } from './csv.js';
import { fromEntity, readStoredMapping, toImport, type StoredMapping } from './import.mapper.js';

export const IMPORT_JOBS = { validate: 'import.validate', commit: 'import.commit' } as const;

export class ImportService {
  constructor(
    private readonly db: Database,
    private readonly storage: FileStorage,
  ) {}

  /** Step 1: store the file and inspect its header. Nothing is imported yet. */
  async upload(
    auth: AuthContext,
    entity: ImportEntity,
    originalName: string,
    body: Readable,
  ): Promise<ImportUploadResponse> {
    const id = newId();
    const fileKey = `imports/${auth.organizationId}/${id}.csv`;
    const sizeBytes = await this.storage.write(fileKey, body, MAX_IMPORT_BYTES);

    let inspected: Awaited<ReturnType<typeof inspectCsv>>;
    try {
      inspected = await inspectCsv(() => this.storage.read(fileKey));
    } catch (err) {
      await this.storage.remove(fileKey);
      throw new AppError(
        'VALIDATION_FAILED',
        `The file could not be read as CSV: ${(err as Error).message}`,
      );
    }
    if (inspected.columns.length === 0 || inspected.sample.length === 0) {
      await this.storage.remove(fileKey);
      throw new AppError(
        'VALIDATION_FAILED',
        'The file needs a header row and at least one data row',
      );
    }

    const stored: StoredMapping = {
      columns: inspected.columns,
      delimiter: inspected.delimiter,
      mapping: null,
      options: null,
    };
    const row = await this.db.run(auth, (tx) =>
      tx.import.create({
        data: {
          id,
          organizationId: auth.organizationId,
          entity: fromEntity(entity),
          fileKey,
          originalName: originalName.slice(0, 200),
          sizeBytes,
          mapping: stored as object,
          createdById: auth.userId,
        },
      }),
    );
    return {
      import: toImport(row),
      sampleRows: inspected.sample,
      suggestedMapping: suggestMapping(entity, inspected.columns),
    };
  }

  /** Step 2: save the column mapping and validate every row in the background. */
  async setMapping(auth: AuthContext, id: string, request: ImportMappingRequest): Promise<Import> {
    return this.db.run(auth, async (tx) => {
      const current = await this.find(tx, auth, id);
      if (!['UPLOADED', 'VALIDATED', 'FAILED'].includes(current.status)) {
        throw new AppError(
          'CONFLICT',
          `This import is ${current.status.toLowerCase()} and cannot be remapped`,
        );
      }
      const stored = readStoredMapping(current.mapping);
      const entity = current.entity.toLowerCase() as ImportEntity;
      const mapping = validateMapping(entity, stored.columns, request.mapping);

      const row = await tx.import.update({
        where: { id },
        data: {
          status: 'VALIDATING',
          mapping: {
            ...stored,
            mapping,
            options: request.options as ImportOptions,
          } as object,
          rowsTotal: 0,
          rowsValid: 0,
          rowsFailed: 0,
          errorSample: [],
          errorFileKey: null,
          failureReason: null,
        },
      });
      await enqueueJob(tx, {
        type: IMPORT_JOBS.validate,
        organizationId: auth.organizationId,
        payload: { importId: id },
      });
      return toImport(row);
    });
  }

  /** Step 3: import the valid rows in the background. */
  async commit(auth: AuthContext, id: string): Promise<Import> {
    return this.db.run(auth, async (tx) => {
      const current = await this.find(tx, auth, id);
      if (current.status !== 'VALIDATED') {
        throw new AppError('CONFLICT', 'Only a validated import can be committed');
      }
      if (current.rowsValid === 0) {
        throw new AppError('CONFLICT', 'There are no valid rows to import');
      }
      const row = await tx.import.update({ where: { id }, data: { status: 'IMPORTING' } });
      await enqueueJob(tx, {
        type: IMPORT_JOBS.commit,
        organizationId: auth.organizationId,
        payload: { importId: id },
      });
      return toImport(row);
    });
  }

  async get(auth: AuthContext, id: string): Promise<Import> {
    return toImport(await this.db.run(auth, (tx) => this.find(tx, auth, id)));
  }

  async list(auth: AuthContext): Promise<Import[]> {
    const rows = await this.db.run(auth, (tx) =>
      tx.import.findMany({
        where: { organizationId: auth.organizationId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
    return rows.map(toImport);
  }

  async errorFile(auth: AuthContext, id: string): Promise<{ stream: Readable; filename: string }> {
    const row = await this.db.run(auth, (tx) => this.find(tx, auth, id));
    if (!row.errorFileKey || !(await this.storage.exists(row.errorFileKey))) {
      throw new AppError('NOT_FOUND', 'This import has no error report');
    }
    const base = row.originalName.replace(/\.csv$/i, '').replace(/[^\w.-]+/g, '_');
    return { stream: this.storage.read(row.errorFileKey), filename: `${base}-errors.csv` };
  }

  private async find(
    tx: Parameters<Parameters<Database['run']>[1]>[0],
    auth: AuthContext,
    id: string,
  ) {
    const row = await tx.import.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!row) throw new AppError('NOT_FOUND', 'Import not found');
    return row;
  }
}

/** Every required field mapped, every column real, no column used twice. */
export function validateMapping(
  entity: ImportEntity,
  columns: string[],
  requested: Record<string, string | null>,
): Record<string, string | null> {
  const fields = IMPORT_FIELDS[entity];
  const errors: { path: string; message: string }[] = [];
  const used = new Map<string, string>();
  const mapping: Record<string, string | null> = {};

  for (const key of Object.keys(requested)) {
    if (!fields.some((f) => f.key === key))
      errors.push({ path: `mapping.${key}`, message: 'Unknown field' });
  }
  for (const field of fields) {
    const column = requested[field.key] ?? null;
    if (column === null || column === '') {
      if (field.required)
        errors.push({ path: `mapping.${field.key}`, message: `${field.label} must be mapped` });
      mapping[field.key] = null;
      continue;
    }
    if (!columns.includes(column)) {
      errors.push({
        path: `mapping.${field.key}`,
        message: `Column "${column}" is not in the file`,
      });
    } else if (used.has(column)) {
      errors.push({
        path: `mapping.${field.key}`,
        message: `Column "${column}" is already mapped to ${used.get(column)}`,
      });
    }
    used.set(column, field.label);
    mapping[field.key] = column;
  }
  if (errors.length > 0)
    throw new AppError('VALIDATION_FAILED', 'The column mapping is incomplete', errors);
  return mapping;
}

/** CSV template with the header row for an entity, plus one example row. */
export function templateCsv(entity: ImportEntity): string {
  const fields = IMPORT_FIELDS[entity];
  const example: Record<string, string> =
    entity === 'interactions'
      ? {
          externalId: 'I-9001',
          customerExternalId: 'C-1001',
          type: 'email_clicked',
          occurredAt: '2026-10-04 09:15',
          channel: 'email',
        }
      : entity === 'customers'
        ? {
            externalId: 'C-1001',
            firstName: 'Ana',
            lastName: 'Pérez',
            email: 'ana@example.com',
            phone: '+57 300 000 0000',
            country: 'CO',
            region: 'Antioquia',
            city: 'Medellín',
            registeredAt: '2025-03-02',
            tags: 'newsletter|vip',
            marketingConsent: 'yes',
          }
        : {
            externalId: 'O-5001',
            customerExternalId: 'C-1001',
            orderedAt: '2026-10-05 14:30',
            grossAmount: '120.00',
            discountAmount: '10.00',
            taxAmount: '19.00',
            refundedAmount: '0',
            status: 'completed',
            channel: 'online',
          };
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `${String.fromCharCode(0xfeff)}${fields.map((f) => quote(f.key)).join(',')}\r\n${fields.map((f) => quote(example[f.key] ?? '')).join(',')}\r\n`;
}
