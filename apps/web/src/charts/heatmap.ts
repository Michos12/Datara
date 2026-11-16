import type { EChartsCoreOption } from 'echarts/core';

/**
 * R × F heat map: rows are recency scores 1–5 (bottom to top), columns frequency scores 1–5.
 * `matrix[r-1][f-1]` is the customer count.
 */
export function buildRfHeatmapOption(input: {
  matrix: number[][];
  labels: { recency: string; frequency: string; customers: string };
  colors: { low: string; high: string; text: string; axis: string };
}): EChartsCoreOption {
  const data: [number, number, number][] = [];
  let max = 0;
  input.matrix.forEach((row, r) =>
    row.forEach((count, f) => {
      data.push([f, r, count]);
      max = Math.max(max, count);
    }),
  );
  const scores = ['1', '2', '3', '4', '5'];
  return {
    aria: { enabled: true },
    grid: { left: 8, right: 8, top: 8, bottom: 40, containLabel: true },
    tooltip: {
      formatter: (p: { value: [number, number, number] }) =>
        `R${p.value[1] + 1} · F${p.value[0] + 1}<br/>${input.labels.customers}: ${p.value[2]}`,
    },
    xAxis: {
      type: 'category',
      data: scores,
      name: input.labels.frequency,
      nameLocation: 'middle',
      nameGap: 26,
      axisLabel: { color: input.colors.text },
      nameTextStyle: { color: input.colors.text },
      axisLine: { lineStyle: { color: input.colors.axis } },
    },
    yAxis: {
      type: 'category',
      data: scores,
      name: input.labels.recency,
      nameLocation: 'middle',
      nameGap: 26,
      axisLabel: { color: input.colors.text },
      nameTextStyle: { color: input.colors.text },
      axisLine: { lineStyle: { color: input.colors.axis } },
    },
    visualMap: {
      min: 0,
      max: Math.max(max, 1),
      show: false,
      inRange: { color: [input.colors.low, input.colors.high] },
    },
    series: [
      {
        type: 'heatmap',
        data,
        label: { show: true, color: input.colors.text },
        itemStyle: { borderColor: input.colors.axis, borderWidth: 1 },
      },
    ],
  };
}
