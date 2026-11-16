import { describe, expect, it } from 'vitest';
import {
  assignSegment,
  DEFAULT_SEGMENT_CONFIG,
  segmentConfigSchema,
  uncoveredCells,
} from './segments.js';

describe('default segment configuration', () => {
  it('is valid and covers every recency × frequency cell', () => {
    expect(segmentConfigSchema.safeParse(DEFAULT_SEGMENT_CONFIG).success).toBe(true);
    expect(uncoveredCells(DEFAULT_SEGMENT_CONFIG.rules)).toEqual([]);
  });

  it.each([
    [5, 5, 3, 'champions'],
    [4, 4, 1, 'champions'],
    [1, 5, 5, 'cant_lose_them'],
    [1, 5, 2, 'at_risk'], // high frequency but not high spend
    [2, 3, 3, 'at_risk'],
    [3, 4, 3, 'loyal'],
    [5, 3, 1, 'loyal'],
    [5, 2, 2, 'potential_loyalists'],
    [5, 1, 1, 'new_customers'],
    [4, 1, 5, 'promising'],
    [3, 2, 2, 'need_attention'],
    [2, 1, 1, 'hibernating'],
    [1, 1, 1, 'lost'],
  ])('R%i F%i M%i → %s', (r, f, m, expected) => {
    expect(assignSegment(DEFAULT_SEGMENT_CONFIG.rules, r, f, m)).toBe(expected);
  });
});

describe('segmentConfigSchema', () => {
  it('rejects configurations that leave cells without a segment', () => {
    const result = segmentConfigSchema.safeParse({
      ...DEFAULT_SEGMENT_CONFIG,
      rules: DEFAULT_SEGMENT_CONFIG.rules.filter((r) => r.key !== 'lost'),
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/R1F1, R1F2/);
  });

  it('does not count monetary-only rules toward coverage', () => {
    const onlyMonetary = [
      {
        r: [1, 5] as [number, number],
        f: [1, 5] as [number, number],
        m: [1, 5] as [number, number],
      },
    ];
    expect(uncoveredCells(onlyMonetary)).toHaveLength(25);
  });

  it('rejects duplicate keys, bad colours and inverted ranges', () => {
    const [first, ...rest] = DEFAULT_SEGMENT_CONFIG.rules;
    expect(
      segmentConfigSchema.safeParse({ ...DEFAULT_SEGMENT_CONFIG, rules: [first, first, ...rest] })
        .success,
    ).toBe(false);
    expect(
      segmentConfigSchema.safeParse({
        ...DEFAULT_SEGMENT_CONFIG,
        rules: [{ ...first!, color: 'green' }, ...rest],
      }).success,
    ).toBe(false);
    expect(
      segmentConfigSchema.safeParse({
        ...DEFAULT_SEGMENT_CONFIG,
        rules: [{ ...first!, r: [5, 4] }, ...rest],
      }).success,
    ).toBe(false);
  });

  it('requires monetary thresholds when monetary value is scored by thresholds', () => {
    const config = {
      ...DEFAULT_SEGMENT_CONFIG,
      scoring: { ...DEFAULT_SEGMENT_CONFIG.scoring, monetary: 'thresholds' },
    };
    expect(segmentConfigSchema.safeParse(config).success).toBe(false);
    expect(
      segmentConfigSchema.safeParse({ ...config, monetaryThresholds: [1000, 5000, 20000, 50000] })
        .success,
    ).toBe(true);
    expect(
      segmentConfigSchema.safeParse({ ...config, monetaryThresholds: [1000, 1000, 20000, 50000] })
        .success,
    ).toBe(false);
  });
});
