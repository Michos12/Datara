import {
  importOptionsSchema,
  importRowErrorSchema,
  type Import,
  type ImportEntity,
  type ImportOptions,
  type ImportRowError,
} from '@ci/contracts';
import { z } from 'zod';

/** Shape of the `imports.mapping` JSON column. */
export interface StoredMapping {
  columns: string[];
  delimiter: string;
  mapping: Record<string, string | null> | null;
  options: ImportOptions | null;
}

const storedMappingSchema = z.object({
  columns: z.array(z.string()),
  delimiter: z.string(),
  mapping: z.record(z.string(), z.string().nullable()).nullable(),
  options: importOptionsSchema.nullable(),
});

export function readStoredMapping(value: unknown): StoredMapping {
  const parsed = storedMappingSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : { columns: [], delimiter: ',', mapping: null, options: null };
}

export interface ImportRow {
  id: string;
  entity: 'CUSTOMERS' | 'ORDERS';
  status: 'UPLOADED' | 'VALIDATING' | 'VALIDATED' | 'IMPORTING' | 'COMPLETED' | 'FAILED';
  originalName: string;
  sizeBytes: number;
  mapping: unknown;
  rowsTotal: number;
  rowsValid: number;
  rowsFailed: number;
  rowsInserted: number;
  rowsUpdated: number;
  errorSample: unknown;
  failureReason: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export const toEntity = (entity: ImportRow['entity']) => entity.toLowerCase() as ImportEntity;
export const fromEntity = (entity: ImportEntity) => entity.toUpperCase() as ImportRow['entity'];

export function toImport(row: ImportRow): Import {
  const stored = readStoredMapping(row.mapping);
  const errors = z.array(importRowErrorSchema).safeParse(row.errorSample);
  return {
    id: row.id,
    entity: toEntity(row.entity),
    status: row.status.toLowerCase() as Import['status'],
    originalName: row.originalName,
    sizeBytes: row.sizeBytes,
    columns: stored.columns,
    mapping: stored.mapping,
    options: stored.options,
    rowsTotal: row.rowsTotal,
    rowsValid: row.rowsValid,
    rowsFailed: row.rowsFailed,
    rowsInserted: row.rowsInserted,
    rowsUpdated: row.rowsUpdated,
    errorSample: errors.success ? (errors.data as ImportRowError[]) : [],
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
