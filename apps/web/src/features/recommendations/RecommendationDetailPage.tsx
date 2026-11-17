import type { Recommendation } from '@ci/contracts';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { chartColors } from '../../charts/colors';
import { buildBarOption } from '../../charts/simple';
import { cssToken, EChart } from '../../components/EChart';
import { Alert, Button } from '../../components/forms';
import { Modal } from '../../components/Modal';
import { Card, PageHeader } from '../../components/PageHeader';
import { ApiError, apiDownload } from '../../lib/api';
import { formatDate, formatMoney, formatNumber, formatPercent } from '../../lib/format';
import { useSession } from '../auth/AuthProvider';
import { SegmentBadge } from '../segments/SegmentBadge';
import { PriorityBadge } from './RecommendationCard';
import { useRecommendation, useRecommendationCustomers, useUpdateRecommendation } from './queries';

const RATIO_KEYS = /share|Rate|impact|dropPoints/;

/** Formats a supporting metric by its name: *Cents money, shares and rates as percentages. */
export function formatMetric(key: string, value: unknown, currency: string): string {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number') return String(value);
  if (key.endsWith('Cents')) return formatMoney(Math.round(value), currency);
  if (key === 'pValue') return value < 0.001 ? '< 0.001' : value.toFixed(3);
  if (key === 'zScore') return value.toFixed(2);
  if (RATIO_KEYS.test(key)) return formatPercent(value, { digits: 1 });
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

export function RecommendationDetailPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const session = useSession();
  const { currency, timezone } = session.organization;
  const canAct = session.role !== 'VIEWER';
  const query = useRecommendation(id);

  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <>
        <PageHeader title={notFound ? 'Recommendation not found' : t('errors.generic')} />
        <Link to="/recommendations" className="text-sm text-accent hover:underline">
          ← {t('recommendations.back')}
        </Link>
      </>
    );
  }
  if (!query.data) return <p className="text-sm text-ink-muted">{t('auth.loading')}</p>;
  const r = query.data;
  const metrics = Object.entries(r.metrics).filter(
    // impact equals the revenue share already listed; series is drawn as a chart.
    ([key, value]) => key !== 'series' && key !== 'impact' && typeof value !== 'object',
  );

  return (
    <>
      <Link to="/recommendations" className="mb-3 inline-block text-sm text-accent hover:underline">
        ← {t('recommendations.back')}
      </Link>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <PriorityBadge priority={r.priority} />
        <span className="rounded-full bg-surface-muted px-2 py-0.5">
          {t(`recommendations.statuses.${r.status}`)}
        </span>
        <span>{t(`recommendations.rules.${r.ruleKey}`)}</span>
      </div>
      <PageHeader
        title={r.title}
        description={t('recommendations.detected', {
          first: formatDate(r.firstDetectedAt, undefined, timezone),
          last: formatDate(r.lastDetectedAt, undefined, timezone),
        })}
        actions={canAct && r.status !== 'expired' ? <StatusActions recommendation={r} /> : null}
      />
      {r.status === 'dismissed' && r.dismissReason && (
        <div className="mb-4">
          <Alert tone="info">
            {t('recommendations.dismissedBecause', { reason: r.dismissReason })}
          </Alert>
        </div>
      )}
      {r.status === 'expired' && (
        <div className="mb-4">
          <Alert tone="info">{t('recommendations.expiredHint')}</Alert>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card>
          <Section title={t('recommendations.opportunity')}>{r.opportunity}</Section>
          <Section title={t('recommendations.why')}>{r.explanation}</Section>
          <Section title={t('recommendations.action')}>
            <span className="font-medium text-ink">{r.suggestedAction}</span>
          </Section>
          <p className="mt-4 text-xs text-ink-subtle">
            {t('recommendations.rule', { rule: r.ruleKey, version: r.ruleVersion })}
          </p>
        </Card>
        <div className="grid content-start gap-4">
          <Card className="p-4">
            <p className="text-xs text-ink-muted">
              {t('recommendations.metricLabels.affectedCustomers')}
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {formatNumber(r.affectedCustomers)}
            </p>
          </Card>
          {r.revenueAtStakeCents !== null && (
            <Card className="p-4">
              <p className="text-xs text-ink-muted">{t('recommendations.revenueAtStake')}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {formatMoney(r.revenueAtStakeCents, currency)}
              </p>
              <p className="mt-1 text-xs text-ink-subtle">
                {t('recommendations.revenueAtStakeHint')}
              </p>
            </Card>
          )}
        </div>
      </div>

      <Card className="mt-4">
        <h2 className="mb-3 text-sm font-semibold">{t('recommendations.metrics')}</h2>
        <RetentionSeries recommendation={r} />
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {metrics.map(([key, value]) => (
            <div key={key} className="flex justify-between gap-3 border-b border-line py-1">
              <dt className="text-ink-muted">
                {t(`recommendations.metricLabels.${key}`, { defaultValue: key })}
              </dt>
              <dd className="tabular-nums">{formatMetric(key, value, currency)}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {canAct && <AffectedCustomers id={r.id} ruleKey={r.ruleKey} currency={currency} />}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 last:mb-0">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{title}</h2>
      <p className="mt-1 text-sm">{children}</p>
    </section>
  );
}

/** The retention-decline rule carries the last four periods: show them as bars. */
function RetentionSeries({ recommendation }: { recommendation: Recommendation }) {
  const { t } = useTranslation();
  const series = recommendation.metrics.series;
  const points = useMemo(
    () => (Array.isArray(series) ? (series as { period: string; rate: number | null }[]) : []),
    [series],
  );
  const option = useMemo(
    () =>
      buildBarOption({
        labels: points.map((p) => p.period),
        values: points.map((p) => p.rate ?? 0),
        seriesName: t('recommendations.retentionSeries'),
        color: cssToken('--color-chart-1', '#2f5bd3'),
        colors: chartColors(),
        format: (v) => formatPercent(v, { digits: 0 }),
      }),
    [points, t],
  );
  if (points.length === 0) return null;
  return (
    <div className="mb-4">
      <EChart option={option} ariaLabel={t('recommendations.retentionSeries')} height={200} />
    </div>
  );
}

function StatusActions({ recommendation: r }: { recommendation: Recommendation }) {
  const { t } = useTranslation();
  const update = useUpdateRecommendation(r.id);
  const [dismissing, setDismissing] = useState(false);
  const error = update.error instanceof ApiError ? update.error.message : null;
  return (
    <div className="flex flex-wrap gap-2">
      {error && <Alert tone="error">{error}</Alert>}
      {r.status === 'open' && (
        <Button
          variant="secondary"
          disabled={update.isPending}
          onClick={() => update.mutate({ status: 'acknowledged' })}
        >
          {t('recommendations.acknowledge')}
        </Button>
      )}
      {r.status !== 'done' && (
        <Button disabled={update.isPending} onClick={() => update.mutate({ status: 'done' })}>
          {t('recommendations.markDone')}
        </Button>
      )}
      {r.status !== 'dismissed' && (
        <Button variant="ghost" onClick={() => setDismissing(true)}>
          {t('recommendations.dismiss')}
        </Button>
      )}
      {dismissing && (
        <DismissDialog
          pending={update.isPending}
          onClose={() => setDismissing(false)}
          onDismiss={(reason) =>
            update.mutate(
              { status: 'dismissed', dismissReason: reason },
              { onSuccess: () => setDismissing(false) },
            )
          }
        />
      )}
    </div>
  );
}

function DismissDialog({
  pending,
  onClose,
  onDismiss,
}: {
  pending: boolean;
  onClose: () => void;
  onDismiss: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    if (reason.trim()) onDismiss(reason.trim());
  }
  return (
    <Modal title={t('recommendations.dismissTitle')} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">{t('recommendations.dismissHint')}</p>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('recommendations.dismissReason')}
          <textarea
            className="min-h-24 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-normal"
            value={reason}
            maxLength={500}
            required
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('customer.cancel')}
          </Button>
          <Button type="submit" disabled={pending || !reason.trim()}>
            {t('recommendations.dismiss')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AffectedCustomers({
  id,
  ruleKey,
  currency,
}: {
  id: string;
  ruleKey: string;
  currency: string;
}) {
  const { t } = useTranslation();
  const list = useRecommendationCustomers(id, true);
  const [error, setError] = useState<string | null>(null);
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const total = list.data?.pages[0]?.page.total ?? 0;
  const name = (c: (typeof rows)[number]) =>
    [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c.externalId || c.customerId;

  async function download() {
    setError(null);
    try {
      await apiDownload(`/recommendations/${id}/customers.csv`, `${ruleKey}-customers.csv`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('errors.network'));
    }
  }

  return (
    <Card className="mt-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t('recommendations.customers')}</h2>
          <p className="mt-1 text-xs text-ink-muted">{t('recommendations.customersHint')}</p>
        </div>
        {total > 0 && (
          <Button variant="secondary" className="px-3 py-1.5" onClick={() => void download()}>
            {t('recommendations.downloadCsv')}
          </Button>
        )}
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {list.isPending ? (
        <div className="h-24 animate-pulse rounded-lg bg-surface-muted" />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('recommendations.customers')}</caption>
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
                  <th scope="col" className="py-2 font-medium">
                    {t('recommendations.customer')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t('recommendations.value')}
                  </th>
                  <th scope="col" className="py-2 pl-4 font-medium">
                    {t('recommendations.segment')}
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    {t('recommendations.lastOrder')}
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
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(c.valueCents, currency)}
                    </td>
                    <td className="py-2 pl-4">
                      <SegmentBadge segmentKey={c.segment} />
                    </td>
                    <td className="py-2">{formatDate(c.lastOrderDate, undefined, 'UTC')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-ink-muted">
            <span>{t('recommendations.shown', { shown: rows.length, total })}</span>
            {list.hasNextPage && (
              <Button
                variant="secondary"
                className="px-3 py-1.5"
                onClick={() => void list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {t('recommendations.showMore')}
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
