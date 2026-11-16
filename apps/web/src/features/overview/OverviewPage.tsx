import { useMemo } from 'react';
import { buildTimeSeriesOption } from '../../charts/timeSeries';
import { cssToken, EChart } from '../../components/EChart';
import { Card, PageHeader } from '../../components/PageHeader';
import { formatMoney } from '../../lib/format';

const KPI_PLACEHOLDERS = [
  { key: 'total_customers', label: 'Total customers' },
  { key: 'active_customers', label: 'Active customers' },
  { key: 'new_customers', label: 'New customers' },
  { key: 'returning_customers', label: 'Returning customers' },
  { key: 'retention_rate', label: 'Retention rate' },
  { key: 'churn_rate', label: 'Churn rate' },
  { key: 'aov', label: 'Average order value' },
  { key: 'historical_clv', label: 'Historical CLV' },
];

// Illustrative series used only to verify the chart pipeline in M0. It is labelled as such
// on screen and is replaced by real snapshot data in M3.
const ILLUSTRATIVE_REVENUE_CENTS = [
  1_820_000, 1_910_000, 2_040_000, 1_980_000, 2_210_000, 2_350_000, 2_290_000, 2_480_000, 2_610_000,
  2_550_000, 2_720_000, 1_430_000,
];
const MONTHS = [
  '2025-12',
  '2026-01',
  '2026-02',
  '2026-03',
  '2026-04',
  '2026-05',
  '2026-06',
  '2026-07',
  '2026-08',
  '2026-09',
  '2026-10',
  '2026-11',
];

export function OverviewPage() {
  const option = useMemo(
    () =>
      buildTimeSeriesOption({
        seriesName: 'Net revenue',
        points: MONTHS.map((period, i) => ({
          period,
          value: ILLUSTRATIVE_REVENUE_CENTS[i] ?? null,
        })),
        partialFromIndex: MONTHS.length - 1,
        valueFormatter: (v) => formatMoney(v, 'USD', { compact: true }),
        colors: {
          series: cssToken('--color-chart-1', '#2f5bd3'),
          axis: cssToken('--color-line', '#e2e5ea'),
          grid: cssToken('--color-surface-muted', '#f0f2f5'),
          text: cssToken('--color-ink-subtle', '#8a92a1'),
        },
      }),
    [],
  );

  return (
    <>
      <PageHeader
        title="Overview"
        description="Executive view of customers and revenue. Every metric shows its definition, period and as-of date."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {KPI_PLACEHOLDERS.map((kpi) => (
          <Card key={kpi.key} className="p-4">
            <p className="text-xs font-medium text-ink-muted">{kpi.label}</p>
            <p className="mt-2 text-2xl font-semibold text-ink-subtle" aria-label="No data yet">
              —
            </p>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Revenue trend</h2>
          <span className="rounded-full bg-surface-muted px-2.5 py-0.5 text-xs text-ink-muted">
            Illustrative data · not your business
          </span>
        </div>
        <EChart option={option} ariaLabel="Illustrative monthly net revenue trend" />
        <p className="mt-3 text-xs text-ink-subtle">
          KPIs and trends are computed by the analytics service once customer and order data is
          imported (milestones M2–M3). The dashed segment marks a partial, to-date period.
        </p>
      </Card>
    </>
  );
}
