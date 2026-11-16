import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { buildStackedBarOption } from '../../charts/stackedBars';
import { buildTimeSeriesOption } from '../../charts/timeSeries';
import { cssToken, EChart } from '../../components/EChart';
import { Alert, Button, SelectField, TextField } from '../../components/forms';
import { Card, PageHeader } from '../../components/PageHeader';
import { ApiError, apiRequest } from '../../lib/api';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
} from '../../lib/format';
import { useSession } from '../auth/AuthProvider';
import { useSegmentConfig } from '../segments/queries';
import { KpiCard } from './KpiCard';
import { lastDay, PRESETS, resolvePreset, todayIn, type Preset, type Range } from './periods';
import { useAnalyticsStatus, useDefinitions, useOverview, type Compare } from './queries';

const COMPARES: Compare[] = ['previous_period', 'previous_year', 'none'];

function chartColors() {
  return {
    axis: cssToken('--color-line', '#e2e5ea'),
    grid: cssToken('--color-surface-muted', '#f0f2f5'),
    text: cssToken('--color-ink-subtle', '#8a92a1'),
  };
}

function bucketLabel(period: string, grain: string, locale?: string): string {
  const date = new Date(`${period}T00:00:00Z`);
  const opts: Intl.DateTimeFormatOptions =
    grain === 'month' || grain === 'quarter'
      ? { month: 'short', year: '2-digit', timeZone: 'UTC' }
      : { month: 'short', day: 'numeric', timeZone: 'UTC' };
  return new Intl.DateTimeFormat(locale, opts).format(date);
}

export function OverviewPage() {
  const { t } = useTranslation();
  const session = useSession();
  const queryClient = useQueryClient();
  const { currency, timezone } = session.organization;
  const today = todayIn(timezone);

  const [preset, setPreset] = useState<Preset>('last_month');
  const [custom, setCustom] = useState<Range>(() => resolvePreset('last_month', today));
  const [compare, setCompare] = useState<Compare>('previous_period');
  const [segment, setSegment] = useState('');
  const segmentConfig = useSegmentConfig();
  const range = preset === 'custom' ? custom : resolvePreset(preset, today);
  const validRange = range.end > range.start;

  const overview = useOverview(range, compare, segment);
  const status = useAnalyticsStatus();
  const definitions = useDefinitions();
  const [recomputeError, setRecomputeError] = useState<string | null>(null);

  const data = overview.data;
  const kpis = data?.data.kpis ?? [];
  const byKey = new Map(kpis.map((k) => [k.key, k]));
  const isEmpty =
    data &&
    (byKey.get('total_customers')?.value ?? 0) === 0 &&
    (byKey.get('orders')?.value ?? 0) === 0;
  const compareLabel = data?.meta.comparePeriod
    ? t(compare === 'previous_year' ? 'overview.vsLastYear' : 'overview.vsPrevious')
    : null;

  const trend = useMemo(() => data?.data.trend ?? [], [data]);
  const grain = data?.meta.period.grain ?? 'month';
  const firstPartial = trend.findIndex((p) => p.partial);
  const revenueOption = useMemo(
    () =>
      buildTimeSeriesOption({
        seriesName: t('kpis.revenue_net'),
        points: trend.map((p) => ({ period: bucketLabel(p.period, grain), value: p.revenueNet })),
        ...(firstPartial >= 0 ? { partialFromIndex: firstPartial } : {}),
        valueFormatter: (v) => formatMoney(v, currency, { compact: true }),
        colors: { series: cssToken('--color-chart-1', '#2f5bd3'), ...chartColors() },
      }),
    [trend, grain, firstPartial, currency, t],
  );
  const acquisitionOption = useMemo(
    () =>
      buildStackedBarOption({
        categories: trend.map((p) => bucketLabel(p.period, grain)),
        series: [
          {
            name: t('kpis.new_customers'),
            values: trend.map((p) => p.newCustomers),
            color: cssToken('--color-chart-1', '#2f5bd3'),
          },
          {
            name: t('kpis.returning_customers'),
            values: trend.map((p) => p.returningCustomers),
            color: cssToken('--color-chart-3', '#2a9d8f'),
          },
        ],
        partial: trend.map((p) => p.partial),
        colors: chartColors(),
      }),
    [trend, grain, t],
  );

  async function recompute() {
    setRecomputeError(null);
    try {
      await apiRequest('POST', '/analytics/runs');
      await queryClient.invalidateQueries({ queryKey: ['analytics', 'status'] });
    } catch (err) {
      setRecomputeError(err instanceof ApiError ? err.message : t('errors.network'));
    }
  }

  const run = status.data?.latestRun;
  const canRecompute = session.role !== 'VIEWER';

  return (
    <>
      <PageHeader title={t('overview.title')} description={t('overview.description')} />

      <Card className="mb-4 p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
          <SelectField
            label={t('overview.period')}
            value={preset}
            onChange={(e) => {
              const next = e.target.value as Preset;
              if (next === 'custom') setCustom(range);
              setPreset(next);
            }}
            options={PRESETS.map((p) => ({ value: p, label: t(`overview.presets.${p}`) }))}
          />
          <SelectField
            label={t('overview.compare')}
            value={compare}
            onChange={(e) => setCompare(e.target.value as Compare)}
            options={COMPARES.map((c) => ({ value: c, label: t(`overview.compares.${c}`) }))}
          />
          <SelectField
            label={t('overview.segment')}
            value={segment}
            onChange={(e) => setSegment(e.target.value)}
            options={[
              { value: '', label: t('overview.allCustomers') },
              ...(segmentConfig.data?.config.rules ?? []).map((r) => ({
                value: r.key,
                label: r.name,
              })),
            ]}
          />
          <div className="flex items-end text-xs text-ink-muted md:pb-2.5">
            {formatDate(range.start, undefined, 'UTC')} –{' '}
            {formatDate(lastDay(range), undefined, 'UTC')}
          </div>
        </div>
        {preset === 'custom' && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <TextField
              label={t('overview.from')}
              type="date"
              value={custom.start}
              onChange={(e) => setCustom((r) => ({ ...r, start: e.target.value }))}
            />
            <TextField
              label={t('overview.to')}
              type="date"
              value={lastDay(custom)}
              onChange={(e) => {
                const [y, m, d] = e.target.value.split('-').map(Number) as [number, number, number];
                setCustom((r) => ({
                  ...r,
                  end: new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10),
                }));
              }}
              {...(!validRange ? { error: t('overview.invalidRange') } : {})}
            />
          </div>
        )}
      </Card>

      {overview.isError && (
        <Alert tone="error">
          {overview.error instanceof ApiError && overview.error.status === 503
            ? t('overview.analyticsDown')
            : overview.error instanceof ApiError && overview.error.status === 409
              ? t('segments.noSnapshot')
              : t('errors.generic')}
        </Alert>
      )}

      {data?.meta.warnings.map((w) => (
        <div key={w.code} className="mb-3">
          <Alert tone="info">{w.message}</Alert>
        </div>
      ))}

      {isEmpty ? (
        <Card className="flex flex-col items-start gap-3">
          <h2 className="text-base font-semibold">{t('overview.emptyTitle')}</h2>
          <p className="text-sm text-ink-muted">{t('overview.emptyHint')}</p>
          <Link
            to="/customers"
            className="inline-flex rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            {t('overview.emptyCta')}
          </Link>
        </Card>
      ) : (
        <>
          <div
            className={`grid grid-cols-2 gap-3 lg:grid-cols-4 ${overview.isFetching && !overview.isPending ? 'opacity-60' : ''}`}
            aria-busy={overview.isFetching}
          >
            {overview.isPending
              ? Array.from({ length: 8 }, (_, i) => (
                  <div
                    key={i}
                    className="h-28 animate-pulse rounded-xl border border-line bg-surface"
                  />
                ))
              : kpis.map((kpi) => (
                  <KpiCard
                    key={kpi.key}
                    kpi={kpi}
                    definition={definitions.data?.get(kpi.key)}
                    currency={currency}
                    compareLabel={compareLabel}
                  />
                ))}
          </div>

          {data && (
            <div className="mt-6 grid gap-6 xl:grid-cols-2">
              <Card>
                <h2 className="mb-3 text-sm font-semibold">{t('overview.revenueTrend')}</h2>
                <EChart option={revenueOption} ariaLabel={t('overview.revenueTrend')} />
                <TrendTable
                  rows={trend.map((p) => [
                    bucketLabel(p.period, grain),
                    formatMoney(p.revenueNet, currency),
                  ])}
                  caption={t('overview.revenueTrend')}
                />
              </Card>
              <Card>
                <h2 className="mb-3 text-sm font-semibold">{t('overview.acquisitionTrend')}</h2>
                <EChart option={acquisitionOption} ariaLabel={t('overview.acquisitionTrend')} />
                <TrendTable
                  rows={trend.map((p) => [
                    bucketLabel(p.period, grain),
                    `${formatNumber(p.newCustomers)} / ${formatNumber(p.returningCustomers)}`,
                  ])}
                  caption={t('overview.acquisitionTrend')}
                />
              </Card>
            </div>
          )}
        </>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-xs text-ink-muted">
        <p>
          {data &&
            t('overview.footer', {
              asOf: formatDate(data.meta.asOf, undefined, 'UTC'),
              timezone,
              guests:
                data.data.guestRevenueShare === null
                  ? '—'
                  : formatPercent(data.data.guestRevenueShare),
            })}{' '}
          <Link to="/methodology" className="text-accent hover:underline">
            {t('overview.methodology')}
          </Link>
        </p>
        <div className="flex items-center gap-3">
          <span>
            {status.data?.pending
              ? t('overview.snapshotPending')
              : run?.finishedAt
                ? t('overview.snapshotAt', {
                    at: formatDateTime(run.finishedAt, undefined, timezone),
                  })
                : t('overview.snapshotNone')}
            {!status.data?.pending &&
              status.data?.nextRunAt &&
              ` · ${t('overview.nextRun', {
                at: formatDateTime(status.data.nextRunAt, undefined, timezone),
              })}`}
          </span>
          {canRecompute && (
            <Button
              variant="secondary"
              className="px-3 py-1.5"
              onClick={recompute}
              disabled={Boolean(status.data?.pending)}
            >
              {t('overview.recompute')}
            </Button>
          )}
        </div>
      </div>
      {recomputeError && <Alert tone="error">{recomputeError}</Alert>}
    </>
  );
}

/** Text alternative for a chart (NFR-UX-01): the same numbers, collapsed by default. */
function TrendTable({ rows, caption }: { rows: [string, string][]; caption: string }) {
  const { t } = useTranslation();
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer text-ink-muted">{t('overview.showTable')}</summary>
      <table className="mt-2 w-full">
        <caption className="sr-only">{caption}</caption>
        <tbody className="divide-y divide-line">
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th scope="row" className="py-1 text-left font-normal text-ink-muted">
                {label}
              </th>
              <td className="py-1 text-right tabular-nums">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
