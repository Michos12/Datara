import { currencyMinorUnits } from '@ci/contracts';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { chartColors } from '../../charts/colors';
import { buildRateBandOption } from '../../charts/rateBand';
import { cssToken, EChart } from '../../components/EChart';
import { Button } from '../../components/forms';
import { Card } from '../../components/PageHeader';
import { downloadCsv } from '../../lib/csv';
import { formatDate, formatMoney, formatNumber, formatPercent } from '../../lib/format';
import { useSession } from '../auth/AuthProvider';
import { bucketLabel } from '../overview/periods';
import { SegmentBadge } from '../segments/SegmentBadge';
import { segmentLookup, useSegmentConfig } from '../segments/queries';
import { useChurn, useChurnedCustomers, type BehaviorFilters } from './queries';
import { RateTable } from './RetentionPanel';
import { PanelHeading, QueryNotices } from './shared';

export function ChurnPanel({
  filters,
  canSeeCustomers,
}: {
  filters: BehaviorFilters;
  canSeeCustomers: boolean;
}) {
  const { t } = useTranslation();
  const { currency } = useSession().organization;
  const query = useChurn(filters);
  const segments = segmentLookup(useSegmentConfig().data);
  const data = query.data;
  const grain = data?.meta.period.grain ?? 'month';
  const series = useMemo(() => data?.data.series ?? [], [data]);
  // The list covers the whole (grain-aligned) period the chart shows.
  const listRange = data
    ? { start: data.meta.period.start, end: data.meta.period.end }
    : filters.range;

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
        seriesName: t('behavior.churn.rate'),
        bandName: t('behavior.band'),
        format: (v) => formatPercent(v, { digits: 1 }),
        colors: {
          series: cssToken('--color-chart-5', '#c0392b'),
          band: cssToken('--color-chart-5', '#c0392b'),
          ...chartColors(),
        },
      }),
    [series, grain, t],
  );

  function downloadSeries() {
    downloadCsv(
      `churn-${listRange.start}-${listRange.end}.csv`,
      [
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
      series.map((p) => [
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
    );
  }

  const days = data?.data.churnDays ?? 0;
  return (
    <>
      <QueryNotices error={query.error} warnings={data?.meta.warnings} />
      {data && (
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat
            label={t('behavior.churn.totalChurned')}
            value={formatNumber(data.data.totals.churned)}
          />
          <Stat
            label={t('behavior.churn.totalReactivated')}
            value={formatNumber(data.data.totals.reactivated)}
          />
          <Stat
            label={t('behavior.churn.threshold')}
            value={t('behavior.churn.thresholdValue', { days })}
          />
        </div>
      )}
      <Card>
        <PanelHeading
          title={t('behavior.churn.title')}
          explain={
            <>
              {t('behavior.churn.explain', { days })}{' '}
              <span className="font-medium text-ink">{t('behavior.churn.notRetention')}</span>
            </>
          }
          onDownload={series.length ? downloadSeries : undefined}
        />
        {query.isPending ? (
          <div className="h-[280px] animate-pulse rounded-lg bg-surface-muted" />
        ) : (
          <EChart option={option} ariaLabel={t('behavior.churn.title')} />
        )}
        <RateTable
          caption={t('behavior.churn.title')}
          columns={[
            t('behavior.period'),
            t('behavior.churn.base'),
            t('behavior.churn.reactivated'),
            t('behavior.churn.churned'),
            t('behavior.churn.rate'),
          ]}
          rows={series.map((p) => ({
            key: p.period,
            cells: [
              `${bucketLabel(p.period, grain)}${p.partial ? ` (${t('behavior.partial')})` : ''}`,
              formatNumber(p.base),
              formatNumber(p.reactivated),
              formatNumber(p.churned),
              p.rate === null ? '—' : formatPercent(p.rate),
            ],
            lowSample: p.lowSample && p.base > 0,
          }))}
        />
      </Card>

      {data && data.data.bySegment.length > 0 && (
        <Card className="mt-4">
          <PanelHeading
            title={t('behavior.churn.bySegment')}
            explain={t('behavior.churn.bySegmentHint', {
              date: formatDate(data.data.segmentAsOf, undefined, 'UTC'),
            })}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
                  <th scope="col" className="py-2 font-medium">
                    {t('segments.segment')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t('behavior.churn.base')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t('behavior.churn.churned')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t('behavior.churn.rate')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.data.bySegment.map((row) => (
                  <tr key={row.segment ?? 'unscored'}>
                    <th scope="row" className="py-2 text-left font-normal">
                      {row.segment ? (
                        (segments.get(row.segment)?.name ?? row.segment)
                      ) : (
                        <span className="text-ink-muted">{t('behavior.churn.unscored')}</span>
                      )}
                    </th>
                    <td className="py-2 text-right tabular-nums">{formatNumber(row.base)}</td>
                    <td className="py-2 text-right tabular-nums">{formatNumber(row.churned)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {row.rate === null ? '—' : formatPercent(row.rate)}
                      {row.lowSample && (
                        <span className="ml-1 text-warning" title={t('overview.lowSampleHint')}>
                          *
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {canSeeCustomers && data && (
        <ChurnedCustomers range={listRange} segment={filters.segment} currency={currency} />
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function ChurnedCustomers({
  range,
  segment,
  currency,
}: {
  range: { start: string; end: string };
  segment: string;
  currency: string;
}) {
  const { t } = useTranslation();
  const list = useChurnedCustomers(range, segment, true);
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const total = list.data?.pages[0]?.page.total ?? 0;
  const name = (c: (typeof rows)[number]) =>
    [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c.externalId || c.customerId;

  async function download() {
    // Fetch every page so the file holds the whole list, not just what is on screen.
    let result = list;
    while (result.hasNextPage) {
      result = (await list.fetchNextPage()) as typeof list;
    }
    const all = result.data?.pages.flatMap((p) => p.data) ?? rows;
    downloadCsv(
      `churned-customers-${range.start}-${range.end}.csv`,
      [
        'customer_id',
        'external_id',
        'name',
        'email',
        'last_purchase',
        'churn_date',
        'orders',
        `lifetime_net_${currency}`,
        'segment_now',
      ],
      all.map((c) => [
        c.customerId,
        c.externalId,
        name(c),
        c.email,
        c.lastPurchase,
        c.churnDate,
        c.orders,
        c.netCents / 10 ** currencyMinorUnits(currency),
        c.segment,
      ]),
    );
  }

  return (
    <Card className="mt-4">
      <PanelHeading
        title={t('behavior.churn.customers')}
        explain={t('behavior.churn.customersHint')}
        onDownload={rows.length ? download : undefined}
      />
      {list.isPending ? (
        <div className="h-24 animate-pulse rounded-lg bg-surface-muted" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('behavior.churn.noneChurned')}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
                  <th scope="col" className="py-2 font-medium">
                    {t('behavior.churn.customer')}
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    {t('behavior.churn.lastPurchase')}
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    {t('behavior.churn.churnDate')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t('behavior.churn.orders')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t('behavior.churn.lifetime')}
                  </th>
                  <th scope="col" className="py-2 pl-4 font-medium">
                    {t('behavior.churn.segmentNow')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((c) => (
                  <tr key={c.customerId}>
                    <td className="py-2">
                      <Link
                        to={`/customers/${c.customerId}`}
                        className="text-accent hover:underline"
                      >
                        {name(c)}
                      </Link>
                    </td>
                    <td className="py-2">{formatDate(c.lastPurchase, undefined, 'UTC')}</td>
                    <td className="py-2">{formatDate(c.churnDate, undefined, 'UTC')}</td>
                    <td className="py-2 text-right tabular-nums">{formatNumber(c.orders)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(c.netCents, currency)}
                    </td>
                    <td className="py-2 pl-4">
                      <SegmentBadge segmentKey={c.segment} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-ink-muted">
            <span>{t('behavior.churn.shown', { shown: rows.length, total })}</span>
            {list.hasNextPage && (
              <Button
                variant="secondary"
                className="px-3 py-1.5"
                onClick={() => void list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {t('behavior.churn.loadMore')}
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
