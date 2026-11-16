import type { EChartsCoreOption } from 'echarts/core';

export interface StackedSeries {
  name: string;
  values: number[];
  color: string;
}

/**
 * Stacked bars over categories (e.g. new vs returning customers per month). Partial buckets are
 * drawn translucent so a "to date" bar is not read as a drop.
 */
export function buildStackedBarOption(input: {
  categories: string[];
  series: StackedSeries[];
  partial?: boolean[];
  colors: { axis: string; grid: string; text: string };
  valueFormatter?: (value: number) => string;
}): EChartsCoreOption {
  const format = input.valueFormatter ?? ((v: number) => String(v));
  return {
    aria: { enabled: true },
    grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
    legend: { top: 0, right: 0, textStyle: { color: input.colors.text }, icon: 'roundRect' },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (v: unknown) => (typeof v === 'number' ? format(v) : '—'),
    },
    xAxis: {
      type: 'category',
      data: input.categories,
      axisLine: { lineStyle: { color: input.colors.axis } },
      axisLabel: { color: input.colors.text },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { color: input.colors.text, formatter: (v: number) => format(v) },
      splitLine: { lineStyle: { color: input.colors.grid } },
    },
    series: input.series.map((s) => ({
      name: s.name,
      type: 'bar',
      stack: 'total',
      barMaxWidth: 36,
      itemStyle: { color: s.color }, // series colour drives the legend swatch
      data: s.values.map((value, i) => ({
        value,
        itemStyle: { color: s.color, opacity: input.partial?.[i] ? 0.45 : 1 },
      })),
    })),
  };
}
