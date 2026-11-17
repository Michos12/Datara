import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { chartColors } from '../../charts/colors';
import { buildBarOption, buildStepCurveOption } from '../../charts/simple';
import { cssToken, EChart } from '../../components/EChart';
import { Card } from '../../components/PageHeader';
import { downloadCsv } from '../../lib/csv';
import { formatNumber, formatPercent } from '../../lib/format';
import { PanelHeading, QueryNotices } from '../behavior/shared';
import { cohortLabel, LowSampleMark, NotYet } from './shared';
import { useFrequency, type ValueFilters } from './queries';
import { Stat } from './ValuePage';

export function FrequencyPanel({ filters }: { filters: ValueFilters }) {
  const { t } = useTranslation();
  const query = useFrequency(filters);
  const data = query.data?.data;
  const days = (n: number) => t('value.days', { count: n });

  const histogram = useMemo(
    () =>
      buildBarOption({
        labels: data?.orderCounts.map((b) => b.bucket) ?? [],
        values: data?.orderCounts.map((b) => b.count) ?? [],
        seriesName: t('value.frequency.customers'),
        color: cssToken('--color-chart-1', '#2f5bd3'),
        colors: chartColors(),
        format: (v) => formatNumber(v),
      }),
    [data, t],
  );
  const gaps = useMemo(
    () =>
      buildBarOption({
        labels: data?.gaps.histogram.map((b) => b.bucket) ?? [],
        values: data?.gaps.histogram.map((b) => b.count) ?? [],
        seriesName: t('value.frequency.gapCount'),
        color: cssToken('--color-chart-3', '#2a9d8f'),
        colors: chartColors(),
        format: (v) => formatNumber(v),
      }),
    [data, t],
  );
  const curve = useMemo(
    () =>
      buildStepCurveOption({
        points: data?.timeToSecond.curve ?? [],
        seriesName: t('value.frequency.share'),
        color: cssToken('--color-chart-2', '#d9822b'),
        colors: chartColors(),
        format: (v) => formatPercent(v, { digits: 0 }),
        daysLabel: (n) => t('value.days', { count: Math.round(n) }),
        maxDays: 365,
      }),
    [data, t],
  );

  if (query.isPending) return <div className="h-64 animate-pulse rounded-lg bg-surface-muted" />;
  if (!data) return <QueryNotices error={query.error} warnings={undefined} />;
  const second = data.timeToSecond;

  function downloadCounts() {
    downloadCsv(
      `purchases-per-customer-${filters.range.start}-${filters.range.end}.csv`,
      ['purchases', 'customers'],
      data!.orderCounts.map((b) => [b.bucket, b.count]),
    );
  }
  function downloadSecond() {
    downloadCsv(
      `time-to-second-purchase-${filters.range.start}-${filters.range.end}.csv`,
      ['days', 'share_with_second_purchase'],
      second.curve.map((p) => [p.days, p.share]),
    );
  }
  function downloadCohorts() {
    downloadCsv(
      `repeat-rate-by-cohort-${filters.range.start}-${filters.range.end}.csv`,
      ['cohort', 'customers', 'repeated', 'repeat_rate', 'ci_low', 'ci_high', 'within_90_days'],
      data!.byCohort.map((c) => [c.cohort, c.size, c.repeated, c.rate, c.low, c.high, c.within90]),
    );
  }

  return (
    <>
      <QueryNotices error={query.error} warnings={query.data?.meta.warnings} />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          label={t('value.frequency.repeatRate')}
          value={data.repeat.rate === null ? '—' : formatPercent(data.repeat.rate)}
          hint={t('value.frequency.repeatHint', {
            repeated: formatNumber(data.repeat.repeated),
            customers: formatNumber(data.repeat.customers),
          })}
        />
        <Stat
          label={t('value.frequency.averagePurchases')}
          value={
            data.averagePurchases === null
              ? '—'
              : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(
                  data.averagePurchases,
                )
          }
        />
        <Stat
          label={t('value.frequency.medianGap')}
          value={data.gaps.median === null ? '—' : days(Math.round(data.gaps.median))}
          {...(data.gaps.p25 !== null && data.gaps.p75 !== null
            ? {
                hint: t('value.frequency.gapRange', {
                  p25: Math.round(data.gaps.p25),
                  p75: Math.round(data.gaps.p75),
                }),
              }
            : {})}
        />
      </div>

      <Card>
        <PanelHeading
          title={t('value.frequency.timeToSecond')}
          explain={t('value.frequency.timeToSecondHint')}
          onDownload={second.curve.length > 1 ? downloadSecond : undefined}
        />
        <p className="mb-3 rounded-lg bg-surface-muted px-3 py-2 text-xs text-ink-muted">
          {t('value.frequency.censoring', {
            censored: formatNumber(second.censored),
            customers: formatNumber(second.customers),
            repeated: formatNumber(second.repeated),
          })}
        </p>
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <EChart option={curve} ariaLabel={t('value.frequency.timeToSecond')} />
          <div>
            <table className="w-full text-sm">
              <caption className="sr-only">{t('value.frequency.timeToSecond')}</caption>
              <thead>
                <tr className="text-left text-xs text-ink-muted">
                  <th scope="col" className="py-1 font-medium">
                    {t('value.frequency.within')}
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    {t('value.frequency.share')}
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    {t('value.frequency.observed')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {second.within.map((w) => (
                  <tr key={w.days}>
                    <th scope="row" className="py-1.5 text-left font-normal">
                      {days(w.days)}
                    </th>
                    <td className="py-1.5 text-right tabular-nums">
                      {formatPercent(w.share, { digits: 0 })}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-ink-muted">
                      {formatNumber(w.observedCustomers)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="mt-3 space-y-1 text-xs text-ink-muted">
              {(['p25', 'median', 'p75'] as const).map((q) => (
                <li key={q}>
                  {t('value.frequency.quantile', {
                    share: { p25: '25%', median: '50%', p75: '75%' }[q],
                  })}{' '}
                  <strong className="text-ink">
                    {second.quantiles[q] === null
                      ? t('value.notReached')
                      : days(second.quantiles[q]!)}
                  </strong>
                </li>
              ))}
              {second.repeaters.median !== null && (
                <li>
                  {t('value.frequency.repeatersMedian', {
                    days: Math.round(second.repeaters.median),
                  })}
                </li>
              )}
            </ul>
          </div>
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <PanelHeading
            title={t('value.frequency.orderCounts')}
            explain={`${t('value.frequency.orderCountsHint')} ${t('value.frequency.occasions')}`}
            onDownload={data.customers ? downloadCounts : undefined}
          />
          <EChart option={histogram} ariaLabel={t('value.frequency.orderCounts')} height={240} />
        </Card>
        <Card>
          <PanelHeading title={t('value.frequency.gaps')} explain={t('value.frequency.gapsHint')} />
          <EChart option={gaps} ariaLabel={t('value.frequency.gaps')} height={240} />
        </Card>
      </div>

      <Card className="mt-4">
        <PanelHeading
          title={t('value.frequency.byCohort')}
          explain={t('value.frequency.byCohortHint')}
          onDownload={data.byCohort.length ? downloadCohorts : undefined}
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('value.frequency.byCohort')}</caption>
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
                <th scope="col" className="py-2 font-medium">
                  {t('value.frequency.cohort')}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t('value.frequency.size')}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t('value.frequency.rate')}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t('value.frequency.within90')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.byCohort.map((c) => (
                <tr key={c.cohort}>
                  <th scope="row" className="py-2 text-left font-normal">
                    {cohortLabel(c.cohort)}
                    {c.lowSample && c.size > 0 && <LowSampleMark />}
                  </th>
                  <td className="py-2 text-right tabular-nums">{formatNumber(c.size)}</td>
                  <td className="py-2 text-right tabular-nums">
                    {c.rate === null ? '—' : formatPercent(c.rate)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {c.within90 === null ? <NotYet /> : formatPercent(c.within90)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
