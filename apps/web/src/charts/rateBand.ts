import type { EChartsCoreOption } from 'echarts/core';

export interface RatePoint {
  label: string;
  rate: number | null;
  low: number | null;
  high: number | null;
  partial: boolean;
}

/**
 * A rate over time with its 95% confidence band (Wilson interval). The band is drawn as two
 * stacked lines: an invisible lower bound and the band width on top of it, filled.
 * Partial (to-date) points are hollow so they are not read as final.
 */
export function buildRateBandOption(input: {
  points: RatePoint[];
  seriesName: string;
  bandName: string;
  colors: { series: string; band: string; axis: string; grid: string; text: string };
  format: (ratio: number) => string;
}): EChartsCoreOption {
  const { points, colors, format } = input;
  const lower = points.map((p) => p.low);
  const width = points.map((p) => (p.low === null || p.high === null ? null : p.high - p.low));
  return {
    aria: { enabled: true },
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      formatter: (params: { dataIndex: number }[]) => {
        const point = points[params[0]?.dataIndex ?? 0];
        if (!point) return '';
        if (point.rate === null) return `${point.label}<br/>No customers to measure`;
        const band =
          point.low !== null && point.high !== null
            ? `<br/>${input.bandName}: ${format(point.low)} – ${format(point.high)}`
            : '';
        return `${point.label}${point.partial ? ' (to date)' : ''}<br/>${input.seriesName}: ${format(point.rate)}${band}`;
      },
    },
    xAxis: {
      type: 'category',
      data: points.map((p) => p.label),
      boundaryGap: false,
      axisLine: { lineStyle: { color: colors.axis } },
      axisLabel: { color: colors.text },
    },
    yAxis: {
      type: 'value',
      min: 0,
      axisLabel: { color: colors.text, formatter: (v: number) => format(v) },
      splitLine: { lineStyle: { color: colors.grid } },
    },
    series: [
      {
        name: 'lower',
        type: 'line',
        data: lower,
        stack: 'band',
        lineStyle: { opacity: 0 },
        showSymbol: false,
        silent: true,
        tooltip: { show: false },
      },
      {
        name: input.bandName,
        type: 'line',
        data: width,
        stack: 'band',
        lineStyle: { opacity: 0 },
        areaStyle: { color: colors.band, opacity: 0.25 },
        showSymbol: false,
        silent: true,
      },
      {
        name: input.seriesName,
        type: 'line',
        data: points.map((p) => ({
          value: p.rate,
          symbol: p.partial ? 'emptyCircle' : 'circle',
        })),
        connectNulls: false,
        symbolSize: 6,
        itemStyle: { color: colors.series },
        lineStyle: { width: 2, color: colors.series },
      },
    ],
  };
}
