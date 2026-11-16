import { z } from 'zod';

/**
 * RFM segmentation configuration (docs/05-analytics-methodology.md §6, SEG-01..07).
 *
 * Recency is scored with the organization's `settings.recencyCutPoints` (thresholds) or by
 * quintile; frequency and monetary value by fixed thresholds or quintile. Segments are assigned
 * by ordered rules: the first rule whose score ranges match wins.
 */

export const SCORING_METHODS = ['thresholds', 'quintile'] as const;
export const scoringMethodSchema = z.enum(SCORING_METHODS);

const score = z.number().int().min(1).max(5);
export const scoreRangeSchema = z
  .tuple([score, score])
  .refine(([min, max]) => min <= max, { message: 'The minimum score must not exceed the maximum' });

export const segmentRuleSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use lowercase letters, digits and underscores'),
  name: z.string().trim().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #2f5bd3'),
  description: z.string().trim().max(300).default(''),
  r: scoreRangeSchema,
  f: scoreRangeSchema,
  /** Optional monetary condition. Rules with one do not count toward R×F coverage. */
  m: scoreRangeSchema.optional(),
});
export type SegmentRule = z.infer<typeof segmentRuleSchema>;

const increasing = (values: number[]) => values.every((v, i) => i === 0 || v > values[i - 1]!);

export const segmentConfigSchema = z
  .strictObject({
    /** Frequency and monetary value count orders in this many days up to the reference date. */
    lookbackDays: z.number().int().min(30).max(1095),
    scoring: z.strictObject({
      recency: scoringMethodSchema,
      frequency: scoringMethodSchema,
      monetary: scoringMethodSchema,
    }),
    /** Minimum orders in the window for scores 2, 3, 4 and 5. */
    frequencyThresholds: z
      .tuple([z.number().int().min(1), z.number().int(), z.number().int(), z.number().int()])
      .refine(increasing, { message: 'Thresholds must increase' }),
    /** Minimum net revenue (minor units) in the window for scores 2–5; used with "thresholds". */
    monetaryThresholds: z
      .tuple([z.number().int().min(0), z.number().int(), z.number().int(), z.number().int()])
      .refine(increasing, { message: 'Thresholds must increase' })
      .nullable(),
    rules: z.array(segmentRuleSchema).min(1).max(20),
  })
  .superRefine((config, ctx) => {
    const keys = new Set<string>();
    config.rules.forEach((rule, i) => {
      if (keys.has(rule.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', i, 'key'],
          message: `Duplicate key "${rule.key}"`,
        });
      }
      keys.add(rule.key);
    });
    if (config.scoring.monetary === 'thresholds' && !config.monetaryThresholds) {
      ctx.addIssue({
        code: 'custom',
        path: ['monetaryThresholds'],
        message: 'Set monetary thresholds or score monetary value by quintile',
      });
    }
    const uncovered = uncoveredCells(config.rules);
    if (uncovered.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['rules'],
        message: `Every recency × frequency combination needs a segment. Missing: ${uncovered
          .slice(0, 6)
          .map(([r, f]) => `R${r}F${f}`)
          .join(', ')}${uncovered.length > 6 ? '…' : ''}`,
      });
    }
  });
export type SegmentConfig = z.infer<typeof segmentConfigSchema>;

/** (R, F) cells that no rule without a monetary condition covers. */
export function uncoveredCells(rules: Pick<SegmentRule, 'r' | 'f' | 'm'>[]): [number, number][] {
  const missing: [number, number][] = [];
  for (let r = 1; r <= 5; r++) {
    for (let f = 1; f <= 5; f++) {
      const covered = rules.some(
        (rule) => !rule.m && rule.r[0] <= r && r <= rule.r[1] && rule.f[0] <= f && f <= rule.f[1],
      );
      if (!covered) missing.push([r, f]);
    }
  }
  return missing;
}

/** The segment a score combination falls into: first matching rule (mirrors the Python engine). */
export function assignSegment(
  rules: Pick<SegmentRule, 'key' | 'r' | 'f' | 'm'>[],
  r: number,
  f: number,
  m: number,
): string | null {
  const inRange = (range: [number, number] | undefined, v: number) =>
    !range || (range[0] <= v && v <= range[1]);
  return (
    rules.find((rule) => inRange(rule.r, r) && inRange(rule.f, f) && inRange(rule.m, m))?.key ??
    null
  );
}

/** Default configuration (methodology §6.3). Seeded as version 1 for every organization. */
export const DEFAULT_SEGMENT_CONFIG: SegmentConfig = {
  lookbackDays: 365,
  scoring: { recency: 'thresholds', frequency: 'thresholds', monetary: 'quintile' },
  frequencyThresholds: [2, 3, 4, 6],
  monetaryThresholds: null,
  rules: [
    {
      key: 'champions',
      name: 'Champions',
      color: '#1d7a4d',
      description: 'Bought recently and buy often.',
      r: [4, 5],
      f: [4, 5],
    },
    {
      key: 'cant_lose_them',
      name: "Can't Lose Them",
      color: '#b43a32',
      description: 'Were top customers by frequency and spend, but have gone quiet.',
      r: [1, 2],
      f: [4, 5],
      m: [4, 5],
    },
    {
      key: 'at_risk',
      name: 'At Risk',
      color: '#d9822b',
      description: 'Used to buy regularly, not recently.',
      r: [1, 2],
      f: [3, 5],
    },
    {
      key: 'loyal',
      name: 'Loyal Customers',
      color: '#2f5bd3',
      description: 'Buy regularly.',
      r: [3, 5],
      f: [3, 5],
    },
    {
      key: 'potential_loyalists',
      name: 'Potential Loyalists',
      color: '#2a9d8f',
      description: 'Recent customers who have made a second purchase.',
      r: [4, 5],
      f: [2, 2],
    },
    {
      key: 'new_customers',
      name: 'New Customers',
      color: '#7c9cf5',
      description: 'Very recent first purchase.',
      r: [5, 5],
      f: [1, 1],
    },
    {
      key: 'promising',
      name: 'Promising',
      color: '#4fc1b3',
      description: 'Recent first purchase.',
      r: [4, 4],
      f: [1, 1],
    },
    {
      key: 'need_attention',
      name: 'Need Attention',
      color: '#c9a227',
      description: 'Middling recency and low frequency.',
      r: [3, 3],
      f: [1, 2],
    },
    {
      key: 'hibernating',
      name: 'Hibernating',
      color: '#8a92a1',
      description: 'Low recency and frequency.',
      r: [2, 2],
      f: [1, 2],
    },
    {
      key: 'lost',
      name: 'Lost',
      color: '#5b6474',
      description: 'Lowest recency and frequency.',
      r: [1, 1],
      f: [1, 2],
    },
  ],
};

export const NO_PURCHASES_SEGMENT = 'no_purchases';

export const segmentConfigVersionSchema = z.object({
  id: z.uuid(),
  version: z.number().int(),
  isActive: z.boolean(),
  config: segmentConfigSchema,
  createdAt: z.string(),
});
export type SegmentConfigVersion = z.infer<typeof segmentConfigVersionSchema>;

export const saveSegmentConfigRequestSchema = z.strictObject({
  config: segmentConfigSchema,
  /** Make the new version the active one (and recompute). */
  activate: z.boolean().default(true),
});

export const segmentSummarySchema = z.object({
  key: z.string(),
  name: z.string(),
  color: z.string(),
  description: z.string(),
  customers: z.number().int(),
  customerShare: z.number(),
  /** Share of the identified customers' net revenue in the look-back window. */
  revenueShare: z.number(),
  avgRecencyDays: z.number().nullable(),
  avgOrders: z.number().nullable(),
  avgSpendCents: z.number().nullable(),
  avgClvCents: z.number().nullable(),
});
export type SegmentSummary = z.infer<typeof segmentSummarySchema>;

export const segmentsResponseSchema = z.object({
  run: z
    .object({ id: z.uuid(), asOf: z.string(), configVersion: z.number().int().nullable() })
    .nullable(),
  lookbackDays: z.number().int(),
  segments: z.array(segmentSummarySchema),
  noPurchases: z.number().int(),
  /** Customers per (recency score, frequency score): matrix[r-1][f-1]. */
  matrix: z.array(z.array(z.number().int())),
});
export type SegmentsResponse = z.infer<typeof segmentsResponseSchema>;

export const segmentPreviewResponseSchema = z.object({
  asOf: z.string(),
  counts: z.record(z.string(), z.number().int()),
  noPurchases: z.number().int(),
  matrix: z.array(z.array(z.number().int())),
});
export type SegmentPreviewResponse = z.infer<typeof segmentPreviewResponseSchema>;
