import { z } from 'zod';
import { metricKindSchema, metricUnitSchema } from './analytics.js';

/** Reports and exports (RPT-02 … 05, ANA-08). */
const segmentParam = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,39}$/)
  .optional();

const isoDate = z.iso.date();

/** Two periods side by side: A is the reference, B is compared with it. */
export const comparisonQuerySchema = z
  .strictObject({
    aStart: isoDate,
    aEnd: isoDate,
    bStart: isoDate,
    bEnd: isoDate,
    segment: segmentParam,
  })
  .refine((q) => q.aEnd > q.aStart, { message: 'end must be after start', path: ['aEnd'] })
  .refine((q) => q.bEnd > q.bStart, { message: 'end must be after start', path: ['bEnd'] });
export type ComparisonQuery = z.infer<typeof comparisonQuerySchema>;

export const comparisonRowSchema = z.object({
  key: z.string(),
  unit: metricUnitSchema,
  kind: metricKindSchema,
  a: z.number().nullable(),
  b: z.number().nullable(),
  /** B − A, in the KPI's unit (percentage points as a fraction for ratios). */
  difference: z.number().nullable(),
  /** (B − A) ÷ |A| for counts and money; null for ratios and when A is 0 or missing. */
  relativeChange: z.number().nullable(),
});
export type ComparisonRow = z.infer<typeof comparisonRowSchema>;

export const comparisonResponseSchema = z.object({
  periodA: z.object({ start: z.string(), end: z.string() }),
  periodB: z.object({ start: z.string(), end: z.string() }),
  segment: z.string().nullable(),
  currency: z.string(),
  rows: z.array(comparisonRowSchema),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});
export type ComparisonResponse = z.infer<typeof comparisonResponseSchema>;

/** Analytics endpoints whose data can be exported as CSV (ANA-08). */
export const EXPORTABLE_METRICS = [
  'overview',
  'retention',
  'churn',
  'cohorts',
  'frequency',
  'clv',
  'journey',
  'engagement',
] as const;
export const exportableMetricSchema = z.enum(EXPORTABLE_METRICS);
export type ExportableMetric = z.infer<typeof exportableMetricSchema>;

export const PDF_SECTIONS = ['overview', 'segments', 'retention', 'recommendations'] as const;
export const pdfSectionSchema = z.enum(PDF_SECTIONS);
export type PdfSection = z.infer<typeof pdfSectionSchema>;

export const pdfReportRequestSchema = z
  .strictObject({
    start: isoDate,
    end: isoDate,
    segment: segmentParam,
    sections: z
      .array(pdfSectionSchema)
      .min(1)
      .default([...PDF_SECTIONS]),
  })
  .refine((q) => q.end > q.start, { message: 'end must be after start', path: ['end'] });
export type PdfReportRequest = z.input<typeof pdfReportRequestSchema>;

export const reportJobSchema = z.object({
  id: z.uuid(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed']),
  fileName: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type ReportJob = z.infer<typeof reportJobSchema>;
