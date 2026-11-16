import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { chartColors } from '../../charts/colors';
import { buildRateBandOption } from '../../charts/rateBand';
import { cssToken, EChart } from '../../components/EChart';
import { Card } from '../../components/PageHeader';
import { downloadCsv } from '../../lib/csv';
import { formatNumber, formatPercent } from '../../lib/format';
import { bucketLabel } from '../overview/periods';
import { PanelHeading, QueryNotices } from './shared';
import { useRetention, type BehaviorFilters } from './queries';

export function RetentionPanel({ filters }: { filters: BehaviorFilters }) {
  const { t } = useTranslation();
  const query = useRetention(filters);
  const data = query.data;
  const grain = data?.meta.period.grain ?? 'month';
  const series = useMemo(() => data?.data.series ?? [], [data]);
  const recommended = data?.data.recommendedGrain;

  const option = useMemo(
    () =>
      buildRateBandOption({
        points: series.map((p) => ({
          label: bucketLabel(p.period, grain),
          rate: p.rate,
          low: p.low,
          high: p.high,
          partial: p.partial,
        })),
        seriesName: t('behavior.retention.rate'),
        bandName: t('behavior.band'),
        format: (v) => formatPercent(v, { digits: 0 }),
        colors: {
          series: cssToken('--color-chart-1', '#2f5bd3'),
          band: cssToken('--color-chart-1', '#2f5bd3'),
          ...chartColors(),
        },
      }),
    [series, grain, t],
  );

  function download() {
    downloadCsv(
      `retention-${filters.range.start}-${filters.range.end}.csv`,
      [
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
      series.map((p) => [
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
    );
  }

  return (
    <>
      <QueryNotices error={query.error} warnings={data?.meta.warnings} />
      <Card>
        <PanelHeading
          title={t('behavior.retention.title')}
          explain={
            <>
              {t('behavior.retention.explain')}{' '}
              {recommended?.medianGapDays != null &&
                t('behavior.retention.gapHint', {
                  days: Math.round(recommended.medianGapDays),
                  grain: t(`behavior.grains.${recommended.grain}`).toLowerCase(),
                })}
            </>
          }
          onDownload={series.length ? download : undefined}
        />
        {query.isPending ? (
          <div className="h-[280px] animate-pulse rounded-lg bg-surface-muted" />
        ) : (
          <EChart option={option} ariaLabel={t('behavior.retention.title')} />
        )}
        <RateTable
          caption={t('behavior.retention.title')}
          columns={[
            t('behavior.period'),
            t('behavior.retention.base'),
            t('behavior.retention.retained'),
            t('behavior.retention.rate'),
          ]}
          rows={series.map((p) => ({
            key: p.period,
            cells: [
              `${bucketLabel(p.period, grain)}${p.partial ? ` (${t('behavior.partial')})` : ''}`,
              formatNumber(p.base),
              formatNumber(p.retained),
              p.rate === null ? '—' : formatPercent(p.rate),
            ],
            lowSample: p.lowSample && p.base > 0,
          }))}
        />
      </Card>
    </>
  );
}

/** The chart's numbers as a table (NFR-UX-01), with small samples marked. */
export function RateTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: { key: string; cells: string[]; lowSample: boolean }[];
}) {
  const { t } = useTranslation();
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer text-ink-muted">{t('overview.showTable')}</summary>
      <div className="overflow-x-auto">
        <table className="mt-2 w-full">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="text-ink-muted">
              {columns.map((c, i) => (
                <th
                  key={c}
                  scope="col"
                  className={`py-1 font-medium ${i ? 'text-right' : 'text-left'}`}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr key={row.key}>
                {row.cells.map((cell, i) =>
                  i === 0 ? (
                    <th key={i} scope="row" className="py-1 text-left font-normal text-ink-muted">
                      {cell}
                    </th>
                  ) : (
                    <td key={i} className="py-1 text-right tabular-nums">
                      {cell}
                      {i === row.cells.length - 1 && row.lowSample && (
                        <span className="ml-1 text-warning" title={t('overview.lowSampleHint')}>
                          *
                        </span>
                      )}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
