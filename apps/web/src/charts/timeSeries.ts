import type { EChartsCoreOption } from 'echarts/core';

export interface TimePoint {
  /** ISO date of the bucket start, e.g. "2026-10-01". */
  period: string;
  value: number | null;
}

export interface TimeSeriesInput {
  seriesName: string;
  points: TimePoint[];
  kind?: 'line' | 'bar';
  /** Formats axis labels and tooltip values. */
  valueFormatter?: (value: number) => string;
  /** Index of the first partial (to-date) period; drawn dashed so it is not read as complete. */
  partialFromIndex?: number;
  colors: { series: string; axis: string; grid: string; text: string };
}

/**
 * Pure ECharts option builder. Kept free of React and DOM so it can be unit-tested and reused
 * by every trend chart (revenue, acquisition, retention).
 * Missing values stay null (gaps), never 0: a gap is "no data", zero is a measurement.
 */
export function buildTimeSeriesOption(input: TimeSeriesInput): EChartsCoreOption {
  const { points, kind = 'line', colors } = input;
  const format = input.valueFormatter ?? ((v: number) => String(v));
  const partial = input.partialFromIndex ?? points.length;

  const complete = points.map((p, i) => (i < partial ? p.value : null));
  // The partial segment starts at the last complete point so the dashed line connects.
  const toDate = points.map((p, i) =>
    i >= partial - 1 && partial < points.length ? p.value : null,
  );

  return {
    aria: { enabled: true },
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: unknown) => (typeof v === 'number' ? format(v) : 'No data'),
    },
    xAxis: {
      type: 'category',
      data: points.map((p) => p.period),
      boundaryGap: kind === 'bar',
      axisLine: { lineStyle: { color: colors.axis } },
      axisLabel: { color: colors.text },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: colors.text, formatter: (v: number) => format(v) },
      splitLine: { lineStyle: { color: colors.grid } },
    },
    series: [
      {
        name: input.seriesName,
        type: kind,
        data: complete,
        connectNulls: false,
        showSymbol: false,
        itemStyle: { color: colors.series },
        lineStyle: { width: 2 },
      },
      ...(partial < points.length
        ? [
            {
              name: `${input.seriesName} (to date)`,
              type: kind,
              data: toDate,
              showSymbol: false,
              itemStyle: { color: colors.series, opacity: 0.5 },
              lineStyle: { width: 2, type: 'dashed' },
            },
          ]
        : []),
    ],
  };
}
