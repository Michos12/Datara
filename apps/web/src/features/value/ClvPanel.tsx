import { CLV_HORIZONS, currencyMinorUnits } from '@ci/contracts';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { chartColors } from '../../charts/colors';
import { buildBarOption } from '../../charts/simple';
import { cssToken, EChart } from '../../components/EChart';
import { Card } from '../../components/PageHeader';
import { downloadCsv } from '../../lib/csv';
import { formatMoney, formatNumber, formatPercent } from '../../lib/format';
import { useSession } from '../auth/AuthProvider';
import { PanelHeading, QueryNotices } from '../behavior/shared';
import { segmentLookup, useSegmentConfig } from '../segments/queries';
import { cohortLabel, LowSampleMark, NotYet } from './shared';
import { useClv, type ValueFilters } from './queries';
import { Stat } from './ValuePage';

export function ClvPanel({ filters }: { filters: ValueFilters }) {
  const { t } = useTranslation();
  const { currency } = useSession().organization;
  const query = useClv(filters);
  const segments = segmentLookup(useSegmentConfig().data);
  const data = query.data?.data;
  const money = (v: number | null) => (v === null ? '—' : formatMoney(Math.round(v), currency));
  const major = (v: number | null) =>
    v === null ? null : Math.round(v) / 10 ** currencyMinorUnits(currency);

  const distribution = useMemo(() => {
    const bins = data?.distribution ?? [];
    const compact = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    });
    const short = (minor: number) => compact.format(minor / 10 ** currencyMinorUnits(currency));
    return buildBarOption({
      labels: bins.map((b) =>
        b.max === null ? `${short(b.min)}+` : `${short(b.min)}–${short(b.max)}`,
      ),
      values: bins.map((b) => b.count),
      seriesName: t('value.frequency.customers'),
      color: cssToken('--color-chart-4', '#9b59b6'),
      colors: chartColors(),
      format: (v) => formatNumber(v),
    });
  }, [data, currency, t]);

  if (query.isPending) return <div className="h-64 animate-pulse rounded-lg bg-surface-muted" />;
  if (!data) return <QueryNotices error={query.error} warnings={undefined} />;
  const s = data.summary;

  function downloadCohorts() {
    downloadCsv(
      `clv-by-cohort-${filters.range.start}-${filters.range.end}.csv`,
      [
        'cohort',
        'customers',
        `to_date_${currency}`,
        ...CLV_HORIZONS.map((h) => `first_${h}_days_${currency}`),
      ],
      data!.byCohort.map((c) => [
        c.cohort,
        c.size,
        major(c.toDate),
        ...CLV_HORIZONS.map((h) => major(c.withinDays[h])),
      ]),
    );
  }
  function downloadSegments() {
    downloadCsv(
      `clv-by-segment.csv`,
      ['segment', 'customers', `mean_${currency}`, `median_${currency}`, 'revenue_share'],
      data!.bySegment.map((r) => [
        r.segment ?? 'not_scored',
        r.customers,
        major(r.mean),
        major(r.median),
        r.revenueShare,
      ]),
    );
  }

  return (
    <>
      <QueryNotices error={query.error} warnings={query.data?.meta.warnings} />
      <p className="mb-3 text-xs text-ink-muted">{t('value.measured')}</p>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={t('value.clv.mean')}
          value={money(s.mean)}
          hint={t('value.clv.customersHint', { count: formatNumber(s.customers) })}
        />
        <Stat
          label={t('value.clv.median')}
          value={money(s.median)}
          hint={t('value.clv.medianHint')}
        />
        <Stat label={t('value.clv.p90')} value={money(s.p90)} />
        <Stat
          label={t('value.clv.top10')}
          value={s.top10Share === null ? '—' : formatPercent(s.top10Share, { digits: 0 })}
        />
      </div>

      <Card>
        <PanelHeading
          title={t('value.clv.distribution')}
          explain={t('value.clv.distributionHint')}
        />
        <EChart option={distribution} ariaLabel={t('value.clv.distribution')} height={240} />
      </Card>

      <Card className="mt-4">
        <PanelHeading
          title={t('value.clv.byCohort')}
          explain={t('value.clv.byCohortHint')}
          onDownload={data.byCohort.length ? downloadCohorts : undefined}
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('value.clv.byCohort')}</caption>
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
                <th scope="col" className="py-2 font-medium">
                  {t('value.frequency.cohort')}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t('value.frequency.size')}
                </th>
                {CLV_HORIZONS.map((h) => (
                  <th key={h} scope="col" className="py-2 text-right font-medium">
                    {t('value.clv.withinDays', { days: h })}
                  </th>
                ))}
                <th scope="col" className="py-2 text-right font-medium">
                  {t('value.clv.toDate')}
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
                  {CLV_HORIZONS.map((h) => (
                    <td key={h} className="py-2 text-right tabular-nums">
                      {c.size === 0 ? (
                        '—'
                      ) : c.withinDays[h] === null ? (
                        <NotYet />
                      ) : (
                        money(c.withinDays[h])
                      )}
                    </td>
                  ))}
                  <td className="py-2 text-right tabular-nums text-ink-muted">{money(c.toDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-4">
        <PanelHeading
          title={t('value.clv.bySegment')}
          explain={t('value.clv.bySegmentHint')}
          onDownload={data.bySegment.length ? downloadSegments : undefined}
        />
        {data.bySegment.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('value.clv.noSnapshot')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('value.clv.bySegment')}</caption>
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
                  <th scope="col" className="py-2 font-medium">
                    {t('value.clv.segment')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t('value.frequency.customers')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t('value.clv.mean')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t('value.clv.median')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t('value.clv.share')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.bySegment.map((r) => (
                  <tr key={r.segment ?? 'unscored'}>
                    <th scope="row" className="py-2 text-left font-normal">
                      {r.segment ? (
                        (segments.get(r.segment)?.name ?? r.segment)
                      ) : (
                        <span className="text-ink-muted">{t('value.clv.unscored')}</span>
                      )}
                      {r.lowSample && <LowSampleMark />}
                    </th>
                    <td className="py-2 text-right tabular-nums">{formatNumber(r.customers)}</td>
                    <td className="py-2 text-right tabular-nums">{money(r.mean)}</td>
                    <td className="py-2 text-right tabular-nums">{money(r.median)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {r.revenueShare === null ? '—' : formatPercent(r.revenueShare, { digits: 1 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
