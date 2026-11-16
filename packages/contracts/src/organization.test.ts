import { describe, expect, it } from 'vitest';
import { signupRequestSchema } from './auth.js';
import {
  INDUSTRIES,
  INDUSTRY_PRESETS,
  organizationSettingsSchema,
  updateOrganizationRequestSchema,
} from './organization.js';

describe('industry presets', () => {
  it.each(INDUSTRIES)('%s preset satisfies the settings schema', (industry) => {
    expect(() => organizationSettingsSchema.parse(INDUSTRY_PRESETS[industry])).not.toThrow();
  });

  it('rejects a churn threshold shorter than the active window', () => {
    const result = organizationSettingsSchema.safeParse({
      ...INDUSTRY_PRESETS.retail,
      activeWindowDays: 200,
      churnDays: 180,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['churnDays']);
  });

  it('rejects non-increasing recency cut points', () => {
    const result = organizationSettingsSchema.safeParse({
      ...INDUSTRY_PRESETS.retail,
      recencyCutPoints: [30, 30, 180, 365],
    });
    expect(result.success).toBe(false);
  });
});

describe('signupRequestSchema', () => {
  const valid = {
    email: '  Ana@Example.COM ',
    password: 'correct horse battery',
    fullName: 'Ana Pérez',
    organization: {
      name: 'Café Central',
      timezone: 'America/Bogota',
      currency: 'cop',
      industry: 'restaurant',
    },
  };

  it('normalizes email and currency', () => {
    const parsed = signupRequestSchema.parse(valid);
    expect(parsed.email).toBe('ana@example.com');
    expect(parsed.organization.currency).toBe('COP');
  });

  it.each([
    ['short password', { password: 'short' }],
    ['unknown time zone', { organization: { ...valid.organization, timezone: 'Mars/Olympus' } }],
    ['unknown currency', { organization: { ...valid.organization, currency: 'XYZ' } }],
    ['unknown industry', { organization: { ...valid.organization, industry: 'mining' } }],
    ['extra fields', { isAdmin: true }],
  ])('rejects %s', (_label, patch) => {
    expect(signupRequestSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

describe('updateOrganizationRequestSchema', () => {
  it('rejects an empty body', () => {
    expect(updateOrganizationRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects immutable fields such as currency', () => {
    expect(updateOrganizationRequestSchema.safeParse({ currency: 'EUR' }).success).toBe(false);
  });
});
