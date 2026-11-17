import { z } from 'zod';
import { analyticsMetaSchema } from './analytics.js';
import { rangeShape, rateShape, withRange } from './behavior.js';
import { interactionTypeSchema } from './interactions.js';

/**
 * Customer value analytics (ANA-04 … 07): purchase frequency, historical CLV, the lifecycle
 * journey and engagement. All figures are measured (kind "measured", engagement score "score");
 * nothing here is a prediction.
 */
export const valueQuerySchema = withRange(z.strictObject(rangeShape));
export type ValueQuery = z.infer<typeof valueQuerySchema>;

const rateSchema = z.object(rateShape);
const nullableNumber = z.number().nullable();

const bucketCountSchema = z.object({
  bucket: z.string(),
  min: z.number().int(),
  max: z.number().int().nullable(),
  count: z.number().int(),
});

// ───────────── frequency ─────────────

export const timeToSecondSchema = z.object({
  customers: z.number().int(),
  repeated: z.number().int(),
  /** Customers without a second purchase yet: counted as still waiting, not as never. */
  censored: z.number().int(),
  within: z.array(
    z.object({
      days: z.number().int(),
      share: z.number(),
      /** Customers acquired at least `days` ago, for whom the horizon is fully observed. */
      observedCustomers: z.number().int(),
    }),
  ),
  /** Kaplan–Meier: days by which 25 / 50 / 75% made a second purchase (null = not reached). */
  quantiles: z.object({
    p25: z.number().int().nullable(),
    median: z.number().int().nullable(),
    p75: z.number().int().nullable(),
  }),
  /** Days to the second purchase among customers who made one. */
  repeaters: z.object({ p25: nullableNumber, median: nullableNumber, p75: nullableNumber }),
  curve: z.array(z.object({ days: z.number().int(), share: z.number() })),
});

export const frequencyResponseSchema = z.object({
  meta: analyticsMetaSchema,
  data: z.object({
    customers: z.number().int(),
    orderCounts: z.array(bucketCountSchema),
    repeat: rateSchema.extend({ customers: z.number().int(), repeated: z.number().int() }),
    averagePurchases: nullableNumber,
    gaps: z.object({
      count: z.number().int(),
      p25: nullableNumber,
      median: nullableNumber,
      p75: nullableNumber,
      mean: nullableNumber,
      histogram: z.array(bucketCountSchema),
    }),
    timeToSecond: timeToSecondSchema,
    byCohort: z.array(
      rateSchema.extend({
        cohort: z.string(),
        size: z.number().int(),
        repeated: z.number().int(),
        /** Share with a second purchase within 90 days; null until the cohort is 90 days old. */
        within90: nullableNumber,
      }),
    ),
  }),
});
export type FrequencyResponse = z.infer<typeof frequencyResponseSchema>;

// ───────────── CLV ─────────────

export const CLV_HORIZONS = ['90', '180', '365'] as const;

export const clvResponseSchema = z.object({
  meta: analyticsMetaSchema,
  data: z.object({
    summary: z.object({
      customers: z.number().int(),
      mean: nullableNumber,
      median: nullableNumber,
      p25: nullableNumber,
      p75: nullableNumber,
      p90: nullableNumber,
      total: z.number().int(),
      /** Share of lifetime revenue from the top 10% of customers by CLV. */
      top10Share: nullableNumber,
    }),
    distribution: z.array(
      z.object({ min: z.number(), max: z.number().nullable(), count: z.number().int() }),
    ),
    byCohort: z.array(
      z.object({
        cohort: z.string(),
        size: z.number().int(),
        lowSample: z.boolean(),
        toDate: nullableNumber,
        /** Mean net revenue within 90 / 180 / 365 days of the first purchase; null = too soon. */
        withinDays: z.record(z.enum(CLV_HORIZONS), nullableNumber),
      }),
    ),
    bySegment: z.array(
      z.object({
        segment: z.string().nullable(),
        customers: z.number().int(),
        mean: z.number(),
        median: z.number(),
        total: z.number().int(),
        revenueShare: nullableNumber,
        lowSample: z.boolean(),
      }),
    ),
  }),
});
export type ClvResponse = z.infer<typeof clvResponseSchema>;

// ───────────── journey ─────────────

export const JOURNEY_STAGES = ['registered', 'first', 'second', 'third', 'active'] as const;
export const journeyStageSchema = z.enum(JOURNEY_STAGES);
export type JourneyStage = z.infer<typeof journeyStageSchema>;

export const journeyResponseSchema = z.object({
  meta: analyticsMetaSchema,
  data: z.object({
    stages: z.array(
      z.object({
        stage: journeyStageSchema,
        customers: z.number().int(),
        /** From the previous stage (for "active": from first purchase). */
        conversion: rateSchema.optional(),
      }),
    ),
    timing: z.array(
      z.object({
        from: journeyStageSchema,
        to: journeyStageSchema,
        customers: z.number().int(),
        reached: z.number().int(),
        censored: z.number().int(),
        /** Kaplan–Meier median days; null while fewer than half have reached the next stage. */
        medianDays: z.number().int().nullable(),
        observedMedianDays: nullableNumber,
      }),
    ),
    beforeFirstPurchase: z.object({
      firstPurchasers: z.number().int(),
      withInteractions: z.number().int(),
      types: z.array(
        z.object({ type: interactionTypeSchema, customers: z.number().int(), share: z.number() }),
      ),
    }),
  }),
});
export type JourneyResponse = z.infer<typeof journeyResponseSchema>;

// ───────────── engagement ─────────────

export const engagementResponseSchema = z.object({
  meta: analyticsMetaSchema,
  data: z.object({
    volume: z.object({
      total: z.number().int(),
      customers: z.number().int(),
      byType: z.array(z.object({ type: interactionTypeSchema, count: z.number().int() })),
      byChannel: z.array(z.object({ channel: z.string().nullable(), count: z.number().int() })),
      series: z.array(
        z.object({
          period: z.string(),
          counts: z.record(interactionTypeSchema, z.number().int()),
        }),
      ),
    }),
    engagedRate: rateSchema.extend({ alive: z.number().int(), engaged: z.number().int() }),
    scores: z.object({
      scored: z.number().int(),
      distribution: z.array(
        z.object({ min: z.number().int(), max: z.number().int(), count: z.number().int() }),
      ),
      median: nullableNumber,
    }),
    /** Spearman ρ of the score 90 days ago vs purchase days since: correlation only. */
    correlation: z.object({
      rho: nullableNumber,
      customers: z.number().int(),
      lowSample: z.boolean(),
    }),
    config: z.object({
      weights: z.record(interactionTypeSchema, z.number().int()),
      cap: z.number().int(),
      windowDays: z.number().int(),
    }),
  }),
});
export type EngagementResponse = z.infer<typeof engagementResponseSchema>;
