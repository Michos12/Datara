import { describe, expect, it } from 'vitest';
import { buildRateBandOption } from './rateBand';

const colors = { series: '#000', band: '#111', axis: '#222', grid: '#333', text: '#444' };

describe('buildRateBandOption', () => {
  it('stacks the band width on an invisible lower bound and keeps gaps as null', () => {
    const option = buildRateBandOption({
      points: [
        { label: 'Sep', rate: 0.4, low: 0.3, high: 0.5, partial: false },
        { label: 'Oct', rate: null, low: null, high: null, partial: false },
        { label: 'Nov', rate: 0.2, low: 0.1, high: 0.4, partial: true },
      ],
      seriesName: 'Retention',
      bandName: 'Band',
      colors,
      format: (v) => `${Math.round(v * 100)}%`,
    }) as { series: { data: unknown[]; stack?: string }[] };
    const [lower, width, rate] = option.series;
    expect(lower!.data).toEqual([0.3, null, 0.1]);
    expect(lower!.stack).toBe('band');
    expect(width!.data[0]).toBeCloseTo(0.2);
    expect(width!.data[1]).toBeNull();
    expect(width!.data[2]).toBeCloseTo(0.3);
    expect(rate!.data).toEqual([
      { value: 0.4, symbol: 'circle' },
      { value: null, symbol: 'circle' },
      { value: 0.2, symbol: 'emptyCircle' },
    ]);
  });
});
