import { z } from 'zod';
import { analyticsMetaSchema } from './analytics.js';

/** Retention and churn compare whole buckets; days are too short for either to mean much. */
export const BEHAVIOR_GRAINS = ['week', 'month', 'quarter'] as const;
export type BehaviorGrain = (typeof BEHAVIOR_GRAINS)[number];

const segmentParam = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,39}$/)
  .optional();

export const rangeShape = {
  start: z.iso.date().optional(),
  end: z.iso.date().optional(),
  /** Limit to customers in this segment as of the latest snapshot. */
  segment: segmentParam,
};

export function withRange<
  T extends z.ZodType<{ start?: string | undefined; end?: string | undefined }>,
>(schema: T) {
  return schema
    .refine((q) => (q.start === undefined) === (q.end === undefined), {
      message: 'Provide both start and end, or neither',
      path: ['end'],
    })
    .refine((q) => !q.start || !q.end || q.end > q.start, {
      message: 'end must be after start',
      path: ['end'],
    });
}

export const behaviorSeriesQuerySchema = withRange(
  z.strictObject({ ...rangeShape, grain: z.enum(BEHAVIOR_GRAINS).optional() }),
);
export type BehaviorSeriesQuery = z.infer<typeof behaviorSeriesQuerySchema>;

export const cohortsQuerySchema = withRange(
  z.strictObject({
    ...rangeShape,
    maxPeriods: z.coerce.number().int().min(1).max(36).default(12),
  }),
);
export type CohortsQuery = z.infer<typeof cohortsQuerySchema>;

export const churnedCustomersQuerySchema = withRange(
  z.strictObject({
    ...rangeShape,
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z
      .string()
      .regex(/^\d{1,7}$/)
      .optional(),
  }),
);
export type ChurnedCustomersQuery = z.infer<typeof churnedCustomersQuerySchema>;

/** A rate with its 95% Wilson interval (docs/05-analytics-methodology.md §9). */
export const rateShape = {
  rate: z.number().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
  /** Fewer than 30 customers in the base (ANA-10). */
  lowSample: z.boolean(),
};

const bucketShape = { period: z.string(), end: z.string(), partial: z.boolean() };

export const recommendedGrainSchema = z.object({
  grain: z.enum(['month', 'quarter']),
  medianGapDays: z.number().nullable(),
});

export const retentionPointSchema = z.object({
  ...bucketShape,
  ...rateShape,
  base: z.number().int(),
  retained: z.number().int(),
});
export type RetentionPoint = z.infer<typeof retentionPointSchema>;

export const retentionResponseSchema = z.object({
  meta: analyticsMetaSchema,
  data: z.object({
    series: z.array(retentionPointSchema),
    recommendedGrain: recommendedGrainSchema,
  }),
});
export type RetentionResponse = z.infer<typeof retentionResponseSchema>;

export const churnPointSchema = z.object({
  ...bucketShape,
  ...rateShape,
  base: z.number().int(),
  churned: z.number().int(),
  reactivated: z.number().int(),
});
export type ChurnPoint = z.infer<typeof churnPointSchema>;

export const churnBySegmentSchema = z.object({
  ...rateShape,
  /** Segment on the day before the range starts; null = alive but unscored then. */
  segment: z.string().nullable(),
  base: z.number().int(),
  churned: z.number().int(),
});

export const churnResponseSchema = z.object({
  meta: analyticsMetaSchema,
  data: z.object({
    series: z.array(churnPointSchema),
    bySegment: z.array(churnBySegmentSchema),
    segmentAsOf: z.string(),
    totals: z.object({ churned: z.number().int(), reactivated: z.number().int() }),
    churnDays: z.number().int(),
    recommendedGrain: recommendedGrainSchema,
  }),
});
export type ChurnResponse = z.infer<typeof churnResponseSchema>;

/** The analytics service's churned-customer list (internal; the API adds customer details). */
export const churnedCustomerFactsSchema = z.object({
  customerId: z.string(),
  lastPurchase: z.string(),
  churnDate: z.string(),
  orders: z.number().int(),
  netCents: z.number().int(),
});

export const churnedCustomersInternalSchema = z.object({
  meta: analyticsMetaSchema,
  data: z.array(churnedCustomerFactsSchema),
});

export const churnedCustomerSchema = churnedCustomerFactsSchema.extend({
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  externalId: z.string().nullable(),
  /** Segment in the latest snapshot. */
  segment: z.string().nullable(),
});
export type ChurnedCustomer = z.infer<typeof churnedCustomerSchema>;

export const churnedCustomersResponseSchema = z.object({
  meta: analyticsMetaSchema,
  data: z.array(churnedCustomerSchema),
  page: z.object({
    nextCursor: z.string().nullable(),
    limit: z.number().int(),
    total: z.number().int(),
  }),
});
export type ChurnedCustomersResponse = z.infer<typeof churnedCustomersResponseSchema>;

const nullableSeries = z.array(z.number().nullable());

export const cohortRowSchema = z.object({
  /** "YYYY-MM": month of the first countable purchase. */
  cohort: z.string(),
  size: z.number().int(),
  lowSample: z.boolean(),
  active: z.array(z.number().int().nullable()),
  retention: nullableSeries,
  /** Minor units per original cohort customer. */
  revenuePerCustomer: nullableSeries,
  cumulativeRevenuePerCustomer: nullableSeries,
});
export type CohortRow = z.infer<typeof cohortRowSchema>;

export const cohortsResponseSchema = z.object({
  meta: analyticsMetaSchema,
  data: z.object({
    periods: z.array(z.number().int()),
    cohorts: z.array(cohortRowSchema),
    /** Size-weighted average over the cohorts whose cell is complete. */
    average: z.object({
      size: z.number().int(),
      retention: nullableSeries,
      revenuePerCustomer: nullableSeries,
      cumulativeRevenuePerCustomer: nullableSeries,
    }),
  }),
});
export type CohortsResponse = z.infer<typeof cohortsResponseSchema>;
