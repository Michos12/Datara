import {
  INDUSTRY_PRESETS,
  industrySchema,
  organizationSettingsSchema,
  type Organization,
  type OrganizationSettings,
} from '@ci/contracts';

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  industry: string;
  settings: unknown;
  createdAt: Date;
}

/**
 * Stored settings merged over the industry preset, so settings added in later versions get a
 * sensible default for existing organizations.
 */
export function resolveSettings(industry: string, stored: unknown): OrganizationSettings {
  const preset = INDUSTRY_PRESETS[industrySchema.catch('other').parse(industry)];
  const merged = { ...preset, ...(typeof stored === 'object' && stored !== null ? stored : {}) };
  const parsed = organizationSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : preset;
}

export function toOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    currency: row.currency.trim(),
    industry: industrySchema.catch('other').parse(row.industry),
    settings: resolveSettings(row.industry, row.settings),
    createdAt: row.createdAt.toISOString(),
  };
}

/** URL-safe slug from a display name plus a random suffix to avoid collisions. */
export function makeSlug(name: string, suffix: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `${base || 'org'}-${suffix}`;
}
