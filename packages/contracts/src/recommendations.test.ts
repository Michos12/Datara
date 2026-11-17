import { describe, expect, it } from 'vitest';
import {
  recommendationListQuerySchema,
  updateRecommendationRequestSchema,
} from './recommendations.js';

describe('recommendation requests', () => {
  it('defaults the inbox to open and acknowledged, and splits lists', () => {
    expect(recommendationListQuerySchema.parse({}).status).toEqual(['open', 'acknowledged']);
    const parsed = recommendationListQuerySchema.parse({
      status: 'done,expired',
      priority: 'high',
    });
    expect(parsed).toMatchObject({ status: ['done', 'expired'], priority: ['high'], limit: 50 });
    expect(recommendationListQuerySchema.safeParse({ status: 'closed' }).success).toBe(false);
  });

  it('requires a reason to dismiss and accepts it only then', () => {
    const parse = (body: object) => updateRecommendationRequestSchema.safeParse(body).success;
    expect(parse({ status: 'dismissed' })).toBe(false);
    expect(parse({ status: 'dismissed', dismissReason: '  ' })).toBe(false);
    expect(parse({ status: 'dismissed', dismissReason: 'Seasonal' })).toBe(true);
    expect(parse({ status: 'done', dismissReason: 'x' })).toBe(false);
    expect(parse({ status: 'acknowledged' })).toBe(true);
    expect(parse({ status: 'open' })).toBe(false);
  });
});
