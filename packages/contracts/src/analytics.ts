import { z } from 'zod';

export const GRAIN_VALUES = ['day', 'week', 'month', 'quarter'] as const;
export const COMPARE_VALUES = ['previous_period', 'previous_year', 'none'] as const;

export const overviewQuerySchema = z
  .strictObject({
    start: z.iso.date().optional(),
    end: z.iso.date().optional(),
    compare: z.enum(COMPARE_VALUES).default('previous_period'),
    grain: z.enum(GRAIN_VALUES).optional(),
    /** Limit to customers in this segment as of the latest snapshot ("no_purchases" allowed). */
    segment: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,39}$/)
      .optional(),
  })
  .refine((q) => (q.start === undefined) === (q.end === undefined), {
    message: 'Provide both start and end, or neither',
    path: ['end'],
  })
  .refine((q) => !q.start || !q.end || q.end > q.start, {
    message: 'end must be after start',
    path: ['end'],
  });
export type OverviewQuery = z.infer<typeof overviewQuerySchema>;

export const metricKindSchema = z.enum(['measured', 'estimated', 'score']);
export const metricUnitSchema = z.enum([
  'count',
  'money',
  'ratio',
  'orders_per_customer',
  'status',
  'days',
  'score',
]);

export const analyticsWarningSchema = z.object({ code: z.string(), message: z.string() });

/** Envelope metadata on every analytics response (ANA-09). */
export const analyticsMetaSchema = z.object({
  metric: z.string(),
  definitionVersions: z.record(z.string(), z.number().int()),
  kind: metricKindSchema,
  period: z.object({ start: z.string(), end: z.string(), grain: z.enum(GRAIN_VALUES) }),
  comparePeriod: z.object({ start: z.string(), end: z.string() }).nullable(),
  asOf: z.string(),
  today: z.string(),
  timezone: z.string(),
  currency: z.string(),
  settings: z.record(z.string(), z.unknown()),
  computedAt: z.string(),
  dataVersion: z.number().int(),
  warnings: z.array(analyticsWarningSchema),
  filters: z
    .object({ segment: z.string().nullable(), segmentRunId: z.string().nullable() })
    .optional(),
  /** Set by the API: whether the response came from the query cache. */
  cached: z.boolean().optional(),
});
export type AnalyticsMeta = z.infer<typeof analyticsMetaSchema>;

export const kpiSchema = z.object({
  key: z.string(),
  value: z.number().nullable(),
  previous: z.number().nullable(),
  /** Relative change (0.1 = +10%), or percentage points as a fraction for rates. */
  change: z.number().nullable(),
  changeType: z.enum(['relative', 'points']),
  unit: metricUnitSchema,
  kind: metricKindSchema,
  numerator: z.number().int().optional(),
  denominator: z.number().int().optional(),
  warning: z.string().optional(),
});
export type Kpi = z.infer<typeof kpiSchema>;

export const trendPointSchema = z.object({
  period: z.string(),
  end: z.string(),
  revenueNet: z.number().int(),
  orders: z.number().int(),
  aov: z.number().int().nullable(),
  buyers: z.number().int(),
  newCustomers: z.number().int(),
  returningCustomers: z.number().int(),
  partial: z.boolean(),
});
export type TrendPoint = z.infer<typeof trendPointSchema>;

export const overviewResponseSchema = z.object({
  meta: analyticsMetaSchema,
  data: z.object({
    kpis: z.array(kpiSchema),
    trend: z.array(trendPointSchema),
    guestRevenueShare: z.number().nullable(),
    historicalClvMedian: z.number().nullable(),
  }),
});
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;

export const metricDefinitionSchema = z.object({
  key: z.string(),
  name: z.string(),
  version: z.number().int(),
  kind: metricKindSchema,
  unit: metricUnitSchema,
  formula: z.string(),
  period_rule: z.string(),
  description: z.string(),
});
export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;

export const definitionsResponseSchema = z.object({ data: z.array(metricDefinitionSchema) });

export const analyticsRunSchema = z.object({
  id: z.uuid(),
  status: z.enum(['running', 'succeeded', 'failed']),
  asOf: z.string(),
  dataVersion: z.number().int(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  stats: z.record(z.string(), z.unknown()).nullable(),
});
export type AnalyticsRun = z.infer<typeof analyticsRunSchema>;

export const analyticsStatusSchema = z.object({
  latestRun: analyticsRunSchema.nullable(),
  /** The latest successful run's data version is behind the organization's current one. */
  stale: z.boolean(),
  /** A recompute is running or due within 15 minutes (an edit, import or "Recompute now"). */
  pending: z.object({ runAfter: z.string() }).nullable(),
  /** The next scheduled run further out (normally tonight's run). */
  nextRunAt: z.string().nullable(),
  dataVersion: z.number().int(),
  dataQuality: z.record(z.string(), z.unknown()).nullable(),
});
export type AnalyticsStatus = z.infer<typeof analyticsStatusSchema>;
