import { describe, expect, it } from 'vitest';
import {
  batchInteractionsRequestSchema,
  createInteractionRequestSchema,
  DEFAULT_ENGAGEMENT_SETTINGS,
  engagementSettingsSchema,
} from './interactions.js';
import { INDUSTRY_PRESETS, organizationSettingsSchema } from './organization.js';

const valid = {
  customerId: '0193a2b4-0000-7000-8000-000000000001',
  type: 'email_clicked',
  occurredAt: '2026-10-01T10:00:00Z',
};

describe('interaction requests', () => {
  it('accepts a minimal interaction and normalises empty text', () => {
    const parsed = createInteractionRequestSchema.parse({ ...valid, channel: '  ' });
    expect(parsed.channel).toBeNull();
  });

  it('keeps metadata flat and small', () => {
    expect(createInteractionRequestSchema.safeParse({ ...valid, metadata: { a: 1 } }).success).toBe(
      true,
    );
    expect(
      createInteractionRequestSchema.safeParse({ ...valid, metadata: { a: { b: 1 } } }).success,
    ).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
    expect(createInteractionRequestSchema.safeParse({ ...valid, metadata: many }).success).toBe(
      false,
    );
  });

  it('limits batches to 1,000 rows', () => {
    const rows = (n: number) => ({ interactions: Array.from({ length: n }, () => valid) });
    expect(batchInteractionsRequestSchema.safeParse(rows(1000)).success).toBe(true);
    expect(batchInteractionsRequestSchema.safeParse(rows(1001)).success).toBe(false);
  });
});

describe('engagement settings', () => {
  it('needs a weight for every type, within 0–10', () => {
    expect(engagementSettingsSchema.safeParse(DEFAULT_ENGAGEMENT_SETTINGS).success).toBe(true);
    const { review: _review, ...missing } = DEFAULT_ENGAGEMENT_SETTINGS.weights;
    expect(engagementSettingsSchema.safeParse({ weights: missing, cap: 10 }).success).toBe(false);
    const heavy = { ...DEFAULT_ENGAGEMENT_SETTINGS.weights, review: 11 };
    expect(engagementSettingsSchema.safeParse({ weights: heavy, cap: 10 }).success).toBe(false);
  });

  it('is optional in organization settings', () => {
    const preset = INDUSTRY_PRESETS.retail;
    expect(organizationSettingsSchema.parse(preset)).not.toHaveProperty('engagement');
    const withEngagement = organizationSettingsSchema.parse({
      ...preset,
      engagement: DEFAULT_ENGAGEMENT_SETTINGS,
    });
    expect(withEngagement.engagement?.cap).toBe(10);
  });
});
