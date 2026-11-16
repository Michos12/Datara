import { z } from 'zod';

export const ROLES = ['OWNER', 'ADMIN', 'ANALYST', 'VIEWER'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const INDUSTRIES = [
  'retail',
  'ecommerce',
  'restaurant',
  'subscription',
  'services',
  'other',
] as const;
export const industrySchema = z.enum(INDUSTRIES);
export type Industry = z.infer<typeof industrySchema>;

export const GRAINS = ['week', 'month', 'quarter'] as const;
export const WEEK_STARTS = ['monday', 'sunday'] as const;

const isValidTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const isValidCurrency = (code: string): boolean => {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
    return Intl.supportedValuesOf('currency').includes(code);
  } catch {
    return false;
  }
};

export const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimezone, { message: 'Must be a valid IANA time zone, e.g. America/Bogota' });

export const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isValidCurrency, { message: 'Must be a valid ISO-4217 currency code, e.g. USD' });

/**
 * Analytics settings per organization (docs/05-analytics-methodology.md §4.4).
 * `recencyCutPoints` are the day boundaries between RFM recency scores 5→4→3→2→1.
 */
export const organizationSettingsSchema = z
  .object({
    activeWindowDays: z.number().int().min(7).max(730),
    churnDays: z.number().int().min(14).max(1095),
    weekStart: z.enum(WEEK_STARTS),
    defaultGrain: z.enum(GRAINS),
    recencyCutPoints: z
      .tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()])
      .refine((p) => p[0] > 0 && p.every((v, i) => i === 0 || v > p[i - 1]!), {
        message: 'Cut points must be positive and strictly increasing',
      }),
  })
  .refine((s) => s.churnDays > s.activeWindowDays, {
    message: 'Churn threshold must be longer than the active window',
    path: ['churnDays'],
  });
export type OrganizationSettings = z.infer<typeof organizationSettingsSchema>;

/** Starting values by industry. Editable per organization; not facts about any one business. */
export const INDUSTRY_PRESETS: Record<Industry, OrganizationSettings> = {
  restaurant: {
    activeWindowDays: 30,
    churnDays: 90,
    weekStart: 'monday',
    defaultGrain: 'week',
    recencyCutPoints: [14, 30, 60, 90],
  },
  retail: {
    activeWindowDays: 90,
    churnDays: 180,
    weekStart: 'monday',
    defaultGrain: 'month',
    recencyCutPoints: [30, 90, 180, 365],
  },
  ecommerce: {
    activeWindowDays: 90,
    churnDays: 180,
    weekStart: 'monday',
    defaultGrain: 'month',
    recencyCutPoints: [30, 90, 180, 365],
  },
  subscription: {
    activeWindowDays: 45,
    churnDays: 90,
    weekStart: 'monday',
    defaultGrain: 'month',
    recencyCutPoints: [30, 45, 90, 180],
  },
  services: {
    activeWindowDays: 180,
    churnDays: 365,
    weekStart: 'monday',
    defaultGrain: 'quarter',
    recencyCutPoints: [60, 180, 365, 540],
  },
  other: {
    activeWindowDays: 90,
    churnDays: 180,
    weekStart: 'monday',
    defaultGrain: 'month',
    recencyCutPoints: [30, 90, 180, 365],
  },
};

export const organizationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  currency: z.string(),
  industry: industrySchema,
  settings: organizationSettingsSchema,
  createdAt: z.string(),
});
export type Organization = z.infer<typeof organizationSchema>;

export const organizationNameSchema = z.string().trim().min(2).max(120);

export const updateOrganizationRequestSchema = z
  .strictObject({
    name: organizationNameSchema.optional(),
    timezone: timezoneSchema.optional(),
    industry: industrySchema.optional(),
    /** Replace the analytics settings. Validated as a whole so cross-field rules hold. */
    settings: organizationSettingsSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
export type UpdateOrganizationRequest = z.infer<typeof updateOrganizationRequestSchema>;

export const auditLogEntrySchema = z.object({
  id: z.uuid(),
  action: z.string(),
  actorUserId: z.uuid().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export const auditLogPageSchema = z.object({
  data: z.array(auditLogEntrySchema),
  page: z.object({ nextCursor: z.string().nullable(), limit: z.number().int() }),
});
export type AuditLogPage = z.infer<typeof auditLogPageSchema>;
