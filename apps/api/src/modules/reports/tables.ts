import {
  currencyMinorUnits,
  type ClvResponse,
  type CohortsResponse,
  type ChurnResponse,
  type ComparisonRow,
  type EngagementResponse,
  type FrequencyResponse,
  type JourneyResponse,
  type Kpi,
  type OverviewResponse,
  type RetentionResponse,
} from '@ci/contracts';

/**
 * Pure table builders for reports and CSV exports (RPT-02, RPT-03, ANA-08). Money leaves as
 * major units (12.50), ratios as fractions (0.25), so spreadsheets can compute with them.
 */
export type Cell = string | number | boolean | null;
export interface Table {
  columns: string[];
  rows: Cell[][];
}

const RATIO_UNITS = new Set(['ratio']);

/** Period comparison (RPT-03): A is the reference, B is compared with it. */
export function compareKpis(a: Kpi[], b: Kpi[]): ComparisonRow[] {
  const byKey = new Map(b.map((k) => [k.key, k]));
  return a.map((ka) => {
    const kb = byKey.get(ka.key);
    const va = ka.value;
    const vb = kb?.value ?? null;
    const difference = va === null || vb === null ? null : vb - va;
    const relativeChange =
      difference === null || RATIO_UNITS.has(ka.unit) || va === 0 || va === null
        ? null
        : difference / Math.abs(va);
    return { key: ka.key, unit: ka.unit, kind: ka.kind, a: va, b: vb, difference, relativeChange };
  });
}

export function moneyConverter(currency: string) {
  const digits = currencyMinorUnits(currency);
  return (minor: number | null) =>
    minor === null ? null : Number((Math.round(minor) / 10 ** digits).toFixed(digits));
}

/** A KPI value in export units: money in major units, everything else as is. */
function exportValue(
  unit: string,
  value: number | null,
  money: (v: number | null) => number | null,
) {
  return unit === 'money' ? money(value) : value;
}

export function comparisonTable(rows: ComparisonRow[], currency: string): Table {
  const money = moneyConverter(currency);
  return {
    columns: ['kpi', 'unit', 'period_a', 'period_b', 'difference', 'relative_change'],
    rows: rows.map((r) => [
      r.key,
      r.unit === 'money' ? `money_${currency}` : r.unit,
      exportValue(r.unit, r.a, money),
      exportValue(r.unit, r.b, money),
      exportValue(r.unit, r.difference, money),
      r.relativeChange,
    ]),
  };
}

export function kpiTable(overview: OverviewResponse, names: Map<string, string>): Table {
  const currency = overview.meta.currency;
  const money = moneyConverter(currency);
  return {
    columns: ['kpi', 'name', 'unit', 'value', 'previous', 'change', 'change_type', 'kind'],
    rows: overview.data.kpis.map((k) => [
      k.key,
      names.get(k.key) ?? k.key,
      k.unit === 'money' ? `money_${currency}` : k.unit,
      exportValue(k.unit, k.value, money),
      exportValue(k.unit, k.previous, money),
      k.change,
      k.changeType,
      k.kind,
    ]),
  };
}

// ───────────── chart data (ANA-08) ─────────────

export function overviewTable(r: OverviewResponse): Table {
  const money = moneyConverter(r.meta.currency);
  return {
    columns: [
      'period_start',
      'period_end',
      `revenue_net_${r.meta.currency}`,
      'orders',
      `aov_${r.meta.currency}`,
      'buyers',
      'new_customers',
      'returning_customers',
      'partial',
    ],
    rows: r.data.trend.map((p) => [
      p.period,
      p.end,
      money(p.revenueNet),
      p.orders,
      money(p.aov),
      p.buyers,
      p.newCustomers,
      p.returningCustomers,
      p.partial,
    ]),
  };
}

export function retentionTable(r: RetentionResponse): Table {
  return {
    columns: [
      'period_start',
      'period_end',
      'base',
      'retained',
      'retention_rate',
      'ci_low',
      'ci_high',
      'low_sample',
      'partial',
    ],
    rows: r.data.series.map((p) => [
      p.period,
      p.end,
      p.base,
      p.retained,
      p.rate,
      p.low,
      p.high,
      p.lowSample,
      p.partial,
    ]),
  };
}

export function churnTable(r: ChurnResponse): Table {
  return {
    columns: [
      'period_start',
      'period_end',
      'alive_at_start',
      'churned',
      'churn_rate',
      'ci_low',
      'ci_high',
      'reactivated',
      'low_sample',
      'partial',
    ],
    rows: r.data.series.map((p) => [
      p.period,
      p.end,
      p.base,
      p.churned,
      p.rate,
      p.low,
      p.high,
      p.reactivated,
      p.lowSample,
      p.partial,
    ]),
  };
}

/** Long format: one row per (cohort, month since acquisition); null = month not over yet. */
export function cohortsTable(r: CohortsResponse): Table {
  const money = moneyConverter(r.meta.currency);
  const c = r.meta.currency;
  const rows: Cell[][] = [];
  for (const cohort of r.data.cohorts) {
    r.data.periods.forEach((k, i) => {
      rows.push([
        cohort.cohort,
        cohort.size,
        k,
        cohort.active[i] ?? null,
        cohort.retention[i] ?? null,
        money(cohort.revenuePerCustomer[i] ?? null),
        money(cohort.cumulativeRevenuePerCustomer[i] ?? null),
      ]);
    });
  }
  return {
    columns: [
      'cohort',
      'cohort_size',
      'month',
      'active_customers',
      'retention',
      `revenue_per_customer_${c}`,
      `cumulative_revenue_per_customer_${c}`,
    ],
    rows,
  };
}

/** Charts on the Customer value page, in one long table: chart, x, value, unit. */
const LONG_COLUMNS = ['chart', 'x', 'value', 'unit'];

export function frequencyTable(r: FrequencyResponse): Table {
  const d = r.data;
  return {
    columns: LONG_COLUMNS,
    rows: [
      ...d.orderCounts.map((b) => ['purchases_per_customer', b.bucket, b.count, 'customers']),
      ...d.gaps.histogram.map((b) => ['days_between_purchases', b.bucket, b.count, 'gaps']),
      ...d.timeToSecond.curve.map((p) => ['time_to_second_purchase', p.days, p.share, 'ratio']),
      ...d.byCohort.map((c) => ['repeat_rate_by_cohort', c.cohort, c.rate, 'ratio']),
    ],
  };
}

export function clvTable(r: ClvResponse): Table {
  const money = moneyConverter(r.meta.currency);
  const unit = `money_${r.meta.currency}`;
  const d = r.data;
  return {
    columns: LONG_COLUMNS,
    rows: [
      ...d.distribution.map((b) => [
        'clv_distribution',
        `${money(b.min)}${b.max === null ? '+' : `-${money(b.max)}`}`,
        b.count,
        'customers',
      ]),
      ...d.byCohort.flatMap((c) =>
        (['90', '180', '365'] as const).map((h) => [
          `clv_first_${h}_days`,
          c.cohort,
          money(c.withinDays[h]),
          unit,
        ]),
      ),
      ...d.bySegment.map((s) => ['clv_by_segment', s.segment ?? 'not_scored', money(s.mean), unit]),
    ],
  };
}

export function journeyTable(r: JourneyResponse): Table {
  return {
    columns: LONG_COLUMNS,
    rows: [
      ...r.data.stages.map((s) => ['funnel', s.stage, s.customers, 'customers']),
      ...r.data.timing.map((t) => [
        'median_days_to_next_step',
        `${t.from}->${t.to}`,
        t.medianDays,
        'days',
      ]),
    ],
  };
}

export function engagementTable(r: EngagementResponse): Table {
  return {
    columns: LONG_COLUMNS,
    rows: [
      ...r.data.volume.series.flatMap((p) =>
        Object.entries(p.counts).map(([type, n]) => [`interactions_${type}`, p.period, n, 'count']),
      ),
      ...r.data.scores.distribution.map((b) => [
        'score_distribution',
        `${b.min}-${b.max}`,
        b.count,
        'customers',
      ]),
    ],
  };
}
