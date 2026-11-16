import { currencyMinorUnits, type CohortRow } from '@ci/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectField } from '../../components/forms';
import { Card } from '../../components/PageHeader';
import { downloadCsv } from '../../lib/csv';
import { formatMoney, formatNumber, formatPercent } from '../../lib/format';
import { useSession } from '../auth/AuthProvider';
import type { Range } from '../overview/periods';
import { useCohorts } from './queries';
import { PanelHeading, QueryNotices } from './shared';

const METRICS = ['retention', 'revenuePerCustomer', 'cumulativeRevenuePerCustomer'] as const;
type Metric = (typeof METRICS)[number];
const HORIZONS = [6, 12, 24];

function cohortLabel(cohort: string, locale?: string) {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${cohort}-01T00:00:00Z`));
}

export function CohortsPanel({ range, segment }: { range: Range; segment: string }) {
  const { t } = useTranslation();
  const { currency } = useSession().organization;
  const [metric, setMetric] = useState<Metric>('retention');
  const [horizon, setHorizon] = useState(12);
  const query = useCohorts(range, segment, horizon);
  const data = query.data?.data;
  const cohorts = (data?.cohorts ?? []).filter((c) => c.size > 0);
  const periods = data?.periods ?? [];

  const isRate = metric === 'retention';
  const format = (v: number) =>
    isRate ? formatPercent(v, { digits: 0 }) : formatMoney(Math.round(v), currency);
  // Colour scale: retention excludes month 0 (always 100%); money scales to the largest cell.
  const scaleValues = cohorts.flatMap((c) =>
    c[metric].filter((v, k): v is number => v !== null && (!isRate || k > 0)),
  );
  const max = Math.max(...scaleValues, isRate ? 0.01 : 1);

  function download() {
    const digits = currencyMinorUnits(currency);
    const value = (v: number | null) =>
      v === null ? null : isRate ? v : Math.round(v) / 10 ** digits;
    downloadCsv(
      `cohorts-${metric}-${range.start}-${range.end}.csv`,
      ['cohort', 'customers', ...periods.map((k) => `month_${k}`)],
      [
        ...cohorts.map((c) => [c.cohort, c.size, ...c[metric].map(value)]),
        ['average', data?.average.size ?? 0, ...(data?.average[metric] ?? []).map(value)],
      ],
    );
  }

  return (
    <>
      <QueryNotices error={query.error} warnings={query.data?.meta.warnings} />
      <Card>
        <PanelHeading
          title={t('behavior.cohorts.title')}
          explain={`${t('behavior.cohorts.explain')} ${t('behavior.cohorts.notYetHint')}`}
          onDownload={cohorts.length ? download : undefined}
        >
          <SelectField
            label={t('behavior.cohorts.metric')}
            value={metric}
            onChange={(e) => setMetric(e.target.value as Metric)}
            options={METRICS.map((m) => ({ value: m, label: t(`behavior.cohorts.metrics.${m}`) }))}
          />
          <SelectField
            label={t('behavior.cohorts.horizon')}
            value={String(horizon)}
            onChange={(e) => setHorizon(Number(e.target.value))}
            options={HORIZONS.map((h) => ({ value: String(h), label: String(h) }))}
          />
        </PanelHeading>

        {query.isPending ? (
          <div className="h-64 animate-pulse rounded-lg bg-surface-muted" />
        ) : cohorts.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('behavior.cohorts.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0.5 text-xs">
              <caption className="sr-only">
                {t('behavior.cohorts.title')}: {t(`behavior.cohorts.metrics.${metric}`)}
              </caption>
              <thead>
                <tr className="text-ink-muted">
                  <th scope="col" className="px-2 py-1 text-left font-medium">
                    {t('behavior.cohorts.cohort')}
                  </th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">
                    {t('behavior.cohorts.size')}
                  </th>
                  {periods.map((k) => (
                    <th
                      key={k}
                      scope="col"
                      className="px-1 py-1 text-center font-medium"
                      title={t('behavior.cohorts.monthLabel', { k })}
                    >
                      {t('behavior.cohorts.month', { k })}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cohorts.map((c) => (
                  <CohortTableRow
                    key={c.cohort}
                    label={cohortLabel(c.cohort)}
                    row={c}
                    values={c[metric]}
                    max={max}
                    isRate={isRate}
                    format={format}
                  />
                ))}
                {data && (
                  <CohortTableRow
                    label={t('behavior.cohorts.average')}
                    row={{ size: data.average.size, lowSample: false }}
                    values={data.average[metric]}
                    max={max}
                    isRate={isRate}
                    format={format}
                    emphasis
                  />
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function CohortTableRow({
  label,
  row,
  values,
  max,
  isRate,
  format,
  emphasis = false,
}: {
  label: string;
  row: Pick<CohortRow, 'size' | 'lowSample'>;
  values: (number | null)[];
  max: number;
  isRate: boolean;
  format: (v: number) => string;
  emphasis?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <tr className={emphasis ? 'font-semibold' : undefined}>
      <th scope="row" className="whitespace-nowrap px-2 py-1 text-left font-normal">
        <span className={emphasis ? 'font-semibold' : undefined}>{label}</span>
        {row.lowSample && (
          <span className="ml-1 text-warning" title={t('behavior.cohorts.lowSample')}>
            *<span className="sr-only">{t('behavior.cohorts.lowSample')}</span>
          </span>
        )}
      </th>
      <td className="px-2 py-1 text-right tabular-nums text-ink-muted">{formatNumber(row.size)}</td>
      {values.map((v, k) => {
        if (v === null) {
          return (
            <td
              key={k}
              className="rounded bg-surface-muted/40 px-1 py-1 text-center text-ink-subtle"
              title={t('behavior.cohorts.notYet')}
            >
              <span aria-hidden="true">·</span>
              <span className="sr-only">{t('behavior.cohorts.notYet')}</span>
            </td>
          );
        }
        const intensity = isRate && k === 0 ? 0 : Math.min(v / max, 1);
        const strong = intensity > 0.55;
        return (
          <td
            key={k}
            className={`rounded px-1 py-1 text-center tabular-nums ${strong ? 'text-white' : ''}`}
            style={{
              backgroundColor: `color-mix(in srgb, var(--color-chart-1) ${Math.round(
                8 + intensity * 82,
              )}%, transparent)`,
            }}
          >
            {format(v)}
          </td>
        );
      })}
    </tr>
  );
}
