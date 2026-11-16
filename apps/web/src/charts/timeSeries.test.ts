import { describe, expect, it } from 'vitest';
import { buildTimeSeriesOption } from './timeSeries';

const colors = { series: '#111', axis: '#222', grid: '#333', text: '#444' };

type Series = { name: string; data: (number | null)[] };
const seriesOf = (option: ReturnType<typeof buildTimeSeriesOption>) => option.series as Series[];

describe('buildTimeSeriesOption', () => {
  const points = [
    { period: '2026-08', value: 10 },
    { period: '2026-09', value: null },
    { period: '2026-10', value: 30 },
    { period: '2026-11', value: 5 },
  ];

  it('keeps missing values as gaps, not zeros', () => {
    const series = seriesOf(buildTimeSeriesOption({ seriesName: 'Revenue', points, colors }));
    expect(series).toHaveLength(1);
    expect(series[0]?.data).toEqual([10, null, 30, 5]);
  });

  it('splits a partial last period into a separate to-date series', () => {
    const series = seriesOf(
      buildTimeSeriesOption({ seriesName: 'Revenue', points, colors, partialFromIndex: 3 }),
    );
    expect(series.map((s) => s.name)).toEqual(['Revenue', 'Revenue (to date)']);
    expect(series[0]?.data).toEqual([10, null, 30, null]);
    // The to-date series starts at the last complete point so the lines connect.
    expect(series[1]?.data).toEqual([null, null, 30, 5]);
  });

  it('uses the period labels as categories', () => {
    const option = buildTimeSeriesOption({ seriesName: 'Revenue', points, colors });
    expect((option.xAxis as { data: string[] }).data).toEqual([
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
  });
});
