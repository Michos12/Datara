import { INTERACTION_TYPES } from '@ci/contracts';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { chartColors } from '../../charts/colors';
import { buildBarOption, buildStackedBarOption } from '../../charts/simple';
import { cssToken, EChart } from '../../components/EChart';
import { Card } from '../../components/PageHeader';
import { downloadCsv } from '../../lib/csv';
import { formatNumber, formatPercent } from '../../lib/format';
import { PanelHeading, QueryNotices } from '../behavior/shared';
import { bucketLabel } from '../overview/periods';
import { useEngagement, type ValueFilters } from './queries';
import { Stat } from './ValuePage';

/** One colour per interaction type: the five theme chart tokens, then fixed extra hues. */
const PALETTE: [string, string][] = [
  ['--color-chart-1', '#2f5bd3'],
  ['--color-chart-2', '#d9822b'],
  ['--color-chart-3', '#2a9d8f'],
  ['--color-chart-4', '#9b59b6'],
  ['--color-chart-5', '#c0392b'],
  ['', '#c9a227'],
  ['', '#1d7a4d'],
  ['', '#8a92a1'],
  ['', '#7c9cf5'],
];
const typeColor = (type: (typeof INTERACTION_TYPES)[number]) => {
  const [token, fallback] = PALETTE[INTERACTION_TYPES.indexOf(type)]!;
  return token ? cssToken(token, fallback) : fallback;
};

export function EngagementPanel({ filters }: { filters: ValueFilters }) {
  const { t } = useTranslation();
  const query = useEngagement(filters);
  const data = query.data?.data;

  const volume = useMemo(() => {
    const series = data?.volume.series ?? [];
    const used = INTERACTION_TYPES.filter((type) => series.some((p) => p.counts[type] > 0));
    return buildStackedBarOption({
      labels: series.map((p) => bucketLabel(p.period, 'month')),
      series: used.map((type) => ({
        name: t(`interactions.types.${type}`),
        values: series.map((p) => p.counts[type]),
        color: typeColor(type),
      })),
      colors: chartColors(),
    });
  }, [data, t]);

  const scores = useMemo(
    () =>
      buildBarOption({
        labels: data?.scores.distribution.map((b) => `${b.min}–${b.max}`) ?? [],
        values: data?.scores.distribution.map((b) => b.count) ?? [],
        seriesName: t('value.frequency.customers'),
        color: cssToken('--color-chart-3', '#2a9d8f'),
        colors: chartColors(),
        format: (v) => formatNumber(v),
      }),
    [data, t],
  );

  if (query.isPending) return <div className="h-64 animate-pulse rounded-lg bg-surface-muted" />;
  if (!data) return <QueryNotices error={query.error} warnings={undefined} />;
  const rate = data.engagedRate;
  const rho = data.correlation.rho;

  function download() {
    downloadCsv(
      `interactions-${filters.range.start}-${filters.range.end}.csv`,
      ['month', ...INTERACTION_TYPES],
      data!.volume.series.map((p) => [
        p.period,
        ...INTERACTION_TYPES.map((type) => p.counts[type]),
      ]),
    );
  }

  return (
    <>
      <QueryNotices error={query.error} warnings={query.data?.meta.warnings} />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          label={t('value.engagement.engagedRate')}
          value={rate.rate === null ? '—' : formatPercent(rate.rate)}
          hint={t('value.engagement.engagedHint', {
            engaged: formatNumber(rate.engaged),
            alive: formatNumber(rate.alive),
          })}
        />
        <Stat
          label={t('value.engagement.total')}
          value={formatNumber(data.volume.total)}
          hint={t('value.engagement.totalHint', { count: formatNumber(data.volume.customers) })}
        />
        <Stat
          label={t('value.engagement.scored')}
          value={formatNumber(data.scores.scored)}
          {...(data.scores.median !== null
            ? { hint: t('value.engagement.scoredHint', { median: Math.round(data.scores.median) }) }
            : {})}
        />
      </div>

      {data.volume.total > 0 && (
        <Card>
          <PanelHeading
            title={t('value.engagement.volume')}
            explain={t('value.engagement.volumeHint')}
            onDownload={download}
          />
          <EChart option={volume} ariaLabel={t('value.engagement.volume')} />
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <CountTable
              caption={t('value.engagement.volume')}
              header={t('interactions.type')}
              rows={data.volume.byType.map((r) => [t(`interactions.types.${r.type}`), r.count])}
            />
            <CountTable
              caption={t('value.engagement.byChannel')}
              header={t('value.engagement.channel')}
              rows={data.volume.byChannel.map((r) => [
                r.channel ?? t('value.engagement.noChannel'),
                r.count,
              ])}
            />
          </div>
        </Card>
      )}

      <Card className="mt-4">
        <PanelHeading
          title={t('value.engagement.scores')}
          explain={t('value.engagement.scoresHint')}
        />
        {data.scores.scored > 0 && (
          <EChart option={scores} ariaLabel={t('value.engagement.scores')} height={220} />
        )}
        <p className="mt-3 text-xs text-ink-muted">
          {rho === null
            ? t('value.engagement.correlationNone')
            : t('value.engagement.correlation', {
                direction: rho >= 0 ? t('value.engagement.more') : t('value.engagement.fewer'),
                rho: rho.toFixed(2),
                count: formatNumber(data.correlation.customers),
              })}
        </p>
      </Card>

      <Card className="mt-4">
        <PanelHeading
          title={t('value.engagement.weights')}
          explain={t('value.engagement.weightsHint', { cap: data.config.cap })}
        />
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          {INTERACTION_TYPES.map((type) => (
            <div key={type} className="flex justify-between gap-2">
              <dt className="text-ink-muted">{t(`interactions.types.${type}`)}</dt>
              <dd className="tabular-nums">{data.config.weights[type]}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </>
  );
}

function CountTable({
  caption,
  header,
  rows,
}: {
  caption: string;
  header: string;
  rows: [string, number][];
}) {
  const { t } = useTranslation();
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
          <th scope="col" className="py-1.5 font-medium">
            {header}
          </th>
          <th scope="col" className="py-1.5 text-right font-medium">
            {t('value.engagement.count')}
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {rows.map(([label, count]) => (
          <tr key={label}>
            <th scope="row" className="py-1.5 text-left font-normal">
              {label}
            </th>
            <td className="py-1.5 text-right tabular-nums">{formatNumber(count)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
