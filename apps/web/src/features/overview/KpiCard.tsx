import type { Kpi, MetricDefinition } from '@ci/contracts';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney, formatNumber, formatPercent } from '../../lib/format';

/** Metrics where a decrease is good news. */
const LOWER_IS_BETTER = new Set(['churn_rate']);

export function formatKpiValue(kpi: Pick<Kpi, 'unit' | 'value'>, currency: string): string {
  if (kpi.value === null) return '—';
  switch (kpi.unit) {
    case 'money':
      return formatMoney(Math.round(kpi.value), currency);
    case 'ratio':
      return formatPercent(kpi.value);
    case 'orders_per_customer':
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(kpi.value);
    default:
      return formatNumber(kpi.value);
  }
}

export function formatChange(kpi: Pick<Kpi, 'change' | 'changeType'>): string | null {
  if (kpi.change === null) return null;
  if (kpi.changeType === 'points') {
    const points = kpi.change * 100;
    return `${points > 0 ? '+' : points < 0 ? '−' : ''}${Math.abs(points).toFixed(1)} pts`;
  }
  const pct = kpi.change * 100;
  return `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(1)}%`;
}

export function KpiCard({
  kpi,
  definition,
  currency,
  compareLabel,
}: {
  kpi: Kpi;
  definition: MetricDefinition | undefined;
  currency: string;
  compareLabel: string | null;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const change = formatChange(kpi);
  const better =
    kpi.change === null || kpi.change === 0
      ? null
      : LOWER_IS_BETTER.has(kpi.key)
        ? kpi.change < 0
        : kpi.change > 0;
  const tone = better === null ? 'text-ink-muted' : better ? 'text-positive' : 'text-negative';
  const label = definition?.name ?? t(`kpis.${kpi.key}`, { defaultValue: kpi.key });

  return (
    <section className="relative rounded-xl border border-line bg-surface p-4" aria-label={label}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-xs font-medium text-ink-muted">{label}</h3>
        <button
          type="button"
          className="-m-1 rounded p-1 text-ink-subtle hover:text-ink"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={t('overview.definitionOf', { name: label })}
          onClick={() => setOpen((v) => !v)}
        >
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
            <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M8 7v4M8 4.6v.1"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{formatKpiValue(kpi, currency)}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs">
        {change && compareLabel && (
          <span className={tone}>
            {change} <span className="text-ink-subtle">{compareLabel}</span>
          </span>
        )}
        {kpi.denominator !== undefined && (
          <span className="text-ink-subtle">
            {formatNumber(kpi.numerator ?? 0)} / {formatNumber(kpi.denominator)}
          </span>
        )}
        {kpi.warning === 'LOW_SAMPLE' && (
          <span
            className="rounded bg-surface-muted px-1.5 py-0.5 text-warning"
            title={t('overview.lowSampleHint')}
          >
            {t('overview.lowSample')}
          </span>
        )}
      </div>
      {open && definition && (
        <div
          id={panelId}
          role="note"
          className="absolute left-0 right-0 top-full z-10 mt-1 rounded-lg border border-line bg-surface p-3 text-xs shadow-lg"
        >
          <p className="font-medium text-ink">{definition.description}</p>
          <p className="mt-2 text-ink-muted">{definition.formula}</p>
          <p className="mt-2 text-ink-subtle">{definition.period_rule}</p>
          <p className="mt-2 text-ink-subtle">
            {t('overview.definitionVersion', { version: definition.version })} ·{' '}
            {t(`overview.kind.${definition.kind}`)}
          </p>
        </div>
      )}
    </section>
  );
}
