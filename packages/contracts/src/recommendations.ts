import { z } from 'zod';

/** Recommendation engine (REC-01 … 05, docs/05-analytics-methodology.md §10). */
export const RECOMMENDATION_RULES = [
  'churn_risk_high_value',
  'reactivation_campaign',
  'protect_champions',
  'loyalty_programme',
  'second_purchase_window',
  'retention_decline',
] as const;
export const recommendationRuleSchema = z.enum(RECOMMENDATION_RULES);
export type RecommendationRule = z.infer<typeof recommendationRuleSchema>;

export const PRIORITIES = ['high', 'medium', 'low'] as const;
export const prioritySchema = z.enum(PRIORITIES);
export type Priority = z.infer<typeof prioritySchema>;

export const RECOMMENDATION_STATUSES = [
  'open',
  'acknowledged',
  'done',
  'dismissed',
  'expired',
] as const;
export const recommendationStatusSchema = z.enum(RECOMMENDATION_STATUSES);
export type RecommendationStatus = z.infer<typeof recommendationStatusSchema>;

/** Statuses a user can set; open and expired are set by the engine. */
export const SETTABLE_STATUSES = ['acknowledged', 'done', 'dismissed'] as const;

const csvOf = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(z.enum(values)).min(1));

export const recommendationListQuerySchema = z.strictObject({
  /** Comma-separated; default open,acknowledged. */
  status: csvOf(RECOMMENDATION_STATUSES).default(['open', 'acknowledged']),
  priority: csvOf(PRIORITIES).optional(),
  ruleKey: recommendationRuleSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type RecommendationListQuery = z.infer<typeof recommendationListQuerySchema>;

export const recommendationSchema = z.object({
  id: z.uuid(),
  ruleKey: recommendationRuleSchema,
  ruleVersion: z.number().int(),
  priority: prioritySchema,
  priorityScore: z.number(),
  status: recommendationStatusSchema,
  title: z.string(),
  opportunity: z.string(),
  explanation: z.string(),
  suggestedAction: z.string(),
  /** Rule-specific supporting metrics, e.g. affectedCustomers, shareOfLast12mRevenue. */
  metrics: z.record(z.string(), z.unknown()),
  affectedCustomers: z.number().int(),
  /** Affected customers' net revenue in the 12 months before the run: measured, not predicted. */
  revenueAtStakeCents: z.number().int().nullable(),
  revenueAtStakeBasis: z.string(),
  dismissReason: z.string().nullable(),
  statusChangedAt: z.string().nullable(),
  firstDetectedAt: z.string(),
  lastDetectedAt: z.string(),
});
export type Recommendation = z.infer<typeof recommendationSchema>;

export const recommendationListSchema = z.object({ data: z.array(recommendationSchema) });
export type RecommendationList = z.infer<typeof recommendationListSchema>;

export const updateRecommendationRequestSchema = z
  .strictObject({
    status: z.enum(SETTABLE_STATUSES),
    dismissReason: z.string().trim().min(1).max(500).optional(),
  })
  .refine((body) => body.status !== 'dismissed' || body.dismissReason !== undefined, {
    message: 'Say why you are dismissing it',
    path: ['dismissReason'],
  })
  .refine((body) => body.status === 'dismissed' || body.dismissReason === undefined, {
    message: 'Only dismissals take a reason',
    path: ['dismissReason'],
  });
export type UpdateRecommendationRequest = z.infer<typeof updateRecommendationRequestSchema>;

export const recommendationCustomersQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z
    .string()
    .regex(/^\d{1,7}$/)
    .optional(),
});
export type RecommendationCustomersQuery = z.infer<typeof recommendationCustomersQuerySchema>;

export const recommendationCustomerSchema = z.object({
  customerId: z.uuid(),
  externalId: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  /** Net revenue in the 12 months before the run. */
  valueCents: z.number().int(),
  segment: z.string().nullable(),
  lastOrderDate: z.string().nullable(),
});
export type RecommendationCustomer = z.infer<typeof recommendationCustomerSchema>;

export const recommendationCustomersPageSchema = z.object({
  data: z.array(recommendationCustomerSchema),
  page: z.object({
    nextCursor: z.string().nullable(),
    limit: z.number().int(),
    total: z.number().int(),
  }),
});
export type RecommendationCustomersPage = z.infer<typeof recommendationCustomersPageSchema>;

export const recommendationRuleSpecSchema = z.object({
  key: recommendationRuleSchema,
  version: z.number().int(),
  name: z.string(),
  trigger: z.string(),
  action: z.string(),
  thresholds: z.record(z.string(), z.number()),
  enabled: z.boolean(),
});
export const recommendationRulesSchema = z.object({ data: z.array(recommendationRuleSpecSchema) });
export type RecommendationRules = z.infer<typeof recommendationRulesSchema>;
