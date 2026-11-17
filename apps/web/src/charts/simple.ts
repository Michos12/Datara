import type { EChartsCoreOption } from 'echarts/core';

export interface AxisColors {
  axis: string;
  grid: string;
  text: string;
}

const grid = { left: 8, right: 16, top: 24, bottom: 8, containLabel: true };

function axes(labels: string[], colors: AxisColors, format: (v: number) => string) {
  return {
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: colors.axis } },
      axisLabel: { color: colors.text },
    },
    yAxis: {
      type: 'value',
      min: 0,
      axisLabel: { color: colors.text, formatter: (v: number) => format(v) },
      splitLine: { lineStyle: { color: colors.grid } },
    },
  };
}

/** One bar per category, e.g. a histogram with labelled buckets. */
export function buildBarOption(input: {
  labels: string[];
  values: number[];
  seriesName: string;
  color: string;
  colors: AxisColors;
  format?: (v: number) => string;
}): EChartsCoreOption {
  const format = input.format ?? ((v: number) => String(v));
  return {
    aria: { enabled: true },
    grid,
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => format(v) },
    ...axes(input.labels, input.colors, format),
    series: [
      {
        name: input.seriesName,
        type: 'bar',
        data: input.values,
        itemStyle: { color: input.color, borderRadius: [3, 3, 0, 0] },
        barMaxWidth: 36,
      },
    ],
  };
}

/** Several series stacked per category (e.g. interactions per month by type). */
export function buildStackedBarOption(input: {
  labels: string[];
  series: { name: string; values: number[]; color: string }[];
  colors: AxisColors;
}): EChartsCoreOption {
  return {
    aria: { enabled: true },
    grid: { ...grid, top: 40 },
    legend: { top: 0, textStyle: { color: input.colors.text }, type: 'scroll' },
    tooltip: { trigger: 'axis' },
    ...axes(input.labels, input.colors, (v) => String(v)),
    series: input.series.map((s) => ({
      name: s.name,
      type: 'bar',
      stack: 'total',
      data: s.values,
      itemStyle: { color: s.color },
      barMaxWidth: 36,
    })),
  };
}

/**
 * A cumulative share over days as a step line (Kaplan–Meier style: the estimate only changes
 * at event times). x is numeric days, y a share 0..1.
 */
export function buildStepCurveOption(input: {
  points: { days: number; share: number }[];
  seriesName: string;
  color: string;
  colors: AxisColors;
  format: (ratio: number) => string;
  daysLabel: (days: number) => string;
  maxDays?: number;
}): EChartsCoreOption {
  const { colors } = input;
  return {
    aria: { enabled: true },
    grid,
    tooltip: {
      trigger: 'axis',
      formatter: (params: { value: [number, number] }[]) => {
        const point = params[0]?.value;
        return point ? `${input.daysLabel(point[0])}<br/>${input.format(point[1])}` : '';
      },
    },
    xAxis: {
      type: 'value',
      min: 0,
      ...(input.maxDays ? { max: input.maxDays } : {}),
      axisLine: { lineStyle: { color: colors.axis } },
      axisLabel: { color: colors.text, formatter: (v: number) => input.daysLabel(v) },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: (value: { max: number }) => Math.min(1, Math.ceil(value.max * 10 + 0.5) / 10),
      axisLabel: { color: colors.text, formatter: (v: number) => input.format(v) },
      splitLine: { lineStyle: { color: colors.grid } },
    },
    series: [
      {
        name: input.seriesName,
        type: 'line',
        step: 'end',
        showSymbol: false,
        data: input.points.map((p) => [p.days, p.share]),
        lineStyle: { width: 2, color: input.color },
        itemStyle: { color: input.color },
        areaStyle: { color: input.color, opacity: 0.08 },
      },
    ],
  };
}
