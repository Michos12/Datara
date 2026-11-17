import { z } from 'zod';

/** Non-purchase events linked to a customer (CUS-06). Stored upper case in Postgres. */
export const INTERACTION_TYPES = [
  'website_visit',
  'email_sent',
  'email_opened',
  'email_clicked',
  'support_ticket',
  'review',
  'loyalty_signup',
  'campaign_response',
  'other',
] as const;
export const interactionTypeSchema = z.enum(INTERACTION_TYPES);
export type InteractionType = z.infer<typeof interactionTypeSchema>;

export const MAX_INTERACTION_BATCH = 1000;

const metadataValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

/** Small, flat key/value details (campaign name, page, ticket number…). No nested objects. */
export const interactionMetadataSchema = z
  .record(z.string().min(1).max(60), metadataValue)
  .refine((m) => Object.keys(m).length <= 20, { message: 'At most 20 metadata keys' });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const createInteractionRequestSchema = z.strictObject({
  customerId: z.uuid(),
  type: interactionTypeSchema,
  occurredAt: z.iso.datetime({ offset: true }),
  channel: optionalText(40),
  /** ID in your system: sending the same ID again updates the interaction instead. */
  externalId: optionalText(120),
  metadata: interactionMetadataSchema.optional(),
});
export type CreateInteractionRequest = z.input<typeof createInteractionRequestSchema>;

export const batchInteractionsRequestSchema = z.strictObject({
  interactions: z.array(createInteractionRequestSchema).min(1).max(MAX_INTERACTION_BATCH),
});
export type BatchInteractionsRequest = z.input<typeof batchInteractionsRequestSchema>;

export const batchInteractionsResponseSchema = z.object({
  inserted: z.number().int(),
  updated: z.number().int(),
});
export type BatchInteractionsResponse = z.infer<typeof batchInteractionsResponseSchema>;

export const interactionSchema = z.object({
  id: z.uuid(),
  customerId: z.uuid(),
  externalId: z.string().nullable(),
  type: interactionTypeSchema,
  channel: z.string().nullable(),
  occurredAt: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type Interaction = z.infer<typeof interactionSchema>;

export const interactionListQuerySchema = z.strictObject({
  customerId: z.uuid().optional(),
  type: interactionTypeSchema.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});
export type InteractionListQuery = z.infer<typeof interactionListQuerySchema>;

export const interactionPageSchema = z.object({
  data: z.array(interactionSchema),
  page: z.object({ nextCursor: z.string().nullable(), limit: z.number().int() }),
});
export type InteractionPage = z.infer<typeof interactionPageSchema>;

/** Engagement score weights (docs/05-analytics-methodology.md §8.3), stored in org settings. */
export const DEFAULT_ENGAGEMENT_WEIGHTS: Record<InteractionType, number> = {
  website_visit: 1,
  email_sent: 0,
  email_opened: 1,
  email_clicked: 3,
  support_ticket: 0,
  review: 5,
  loyalty_signup: 5,
  campaign_response: 4,
  other: 1,
};
export const DEFAULT_ENGAGEMENT_CAP = 10;

export const engagementSettingsSchema = z.strictObject({
  weights: z.record(interactionTypeSchema, z.number().int().min(0).max(10)),
  /** Interactions of one type counted at most this many times per customer in 90 days. */
  cap: z.number().int().min(1).max(100),
});
export type EngagementSettings = z.infer<typeof engagementSettingsSchema>;

export const DEFAULT_ENGAGEMENT_SETTINGS: EngagementSettings = {
  weights: DEFAULT_ENGAGEMENT_WEIGHTS,
  cap: DEFAULT_ENGAGEMENT_CAP,
};
