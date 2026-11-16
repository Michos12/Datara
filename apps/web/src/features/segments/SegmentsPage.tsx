import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { buildRfHeatmapOption } from '../../charts/heatmap';
import { cssToken, EChart } from '../../components/EChart';
import { Alert, Button } from '../../components/forms';
import { Card, PageHeader } from '../../components/PageHeader';
import { formatDate, formatMoney, formatNumber, formatPercent } from '../../lib/format';
import { useSession } from '../auth/AuthProvider';
import { SegmentConfigEditor } from './SegmentConfigEditor';
import { useSegmentConfig, useSegments } from './queries';

export function SegmentsPage() {
  const { t } = useTranslation();
  const session = useSession();
  const { currency } = session.organization;
  const summary = useSegments();
  const config = useSegmentConfig();
  const [editing, setEditing] = useState(false);
  const canEdit = session.role === 'OWNER' || session.role === 'ADMIN';
  const data = summary.data;

  const heatmap = useMemo(
    () =>
      buildRfHeatmapOption({
        matrix: data?.matrix ?? [],
        labels: {
          recency: t('segments.recencyScore'),
          frequency: t('segments.frequencyScore'),
          customers: t('segments.customers'),
        },
        colors: {
          low: cssToken('--color-surface-muted', '#f0f2f5'),
          high: cssToken('--color-chart-1', '#2f5bd3'),
          text: cssToken('--color-ink', '#161a22'),
          axis: cssToken('--color-line', '#e2e5ea'),
        },
      }),
    [data, t],
  );

  return (
    <>
      <PageHeader
        title={t('segments.title')}
        description={t('segments.description')}
        actions={
          canEdit &&
          !editing && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              {t('segments.editRules')}
            </Button>
          )
        }
      />

      {editing && config.data && (
        <div className="mb-6">
          <SegmentConfigEditor current={config.data} onClose={() => setEditing(false)} />
        </div>
      )}

      {data && !data.run && <Alert tone="info">{t('segments.noSnapshot')}</Alert>}

      {data?.run && (
        <>
          <p className="mb-3 text-xs text-ink-muted">
            {t('segments.asOf', {
              date: formatDate(data.run.asOf, undefined, 'UTC'),
              days: data.lookbackDays,
              version: data.run.configVersion ?? '—',
            })}
          </p>
          <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
            <Card className="overflow-hidden p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-line bg-surface-muted text-xs uppercase tracking-wide text-ink-muted">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-medium">
                        {t('segments.segment')}
                      </th>
                      <th scope="col" className="px-4 py-3 text-right font-medium">
                        {t('segments.customers')}
                      </th>
                      <th scope="col" className="px-4 py-3 text-right font-medium">
                        {t('segments.revenueShare')}
                      </th>
                      <th
                        scope="col"
                        className="hidden px-4 py-3 text-right font-medium md:table-cell"
                      >
                        {t('segments.avgRecency')}
                      </th>
                      <th
                        scope="col"
                        className="hidden px-4 py-3 text-right font-medium md:table-cell"
                      >
                        {t('segments.avgOrders')}
                      </th>
                      <th
                        scope="col"
                        className="hidden px-4 py-3 text-right font-medium lg:table-cell"
                      >
                        {t('segments.avgClv')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.segments.map((s) => (
                      <tr key={s.key}>
                        <td className="px-4 py-3">
                          <Link
                            to={`/customers?segment=${s.key}`}
                            className="flex items-center gap-2 font-medium hover:text-accent"
                          >
                            <span
                              aria-hidden="true"
                              className="size-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: s.color }}
                            />
                            {s.name}
                          </Link>
                          <p className="mt-0.5 text-xs text-ink-subtle">{s.description}</p>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatNumber(s.customers)}
                          <div
                            className="mt-1 h-1.5 overflow-hidden rounded bg-surface-muted"
                            aria-hidden="true"
                          >
                            <div
                              className="h-full rounded"
                              style={{
                                width: `${s.customerShare * 100}%`,
                                backgroundColor: s.color,
                              }}
                            />
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatPercent(s.revenueShare)}
                        </td>
                        <td className="hidden px-4 py-3 text-right tabular-nums md:table-cell">
                          {s.avgRecencyDays === null
                            ? '—'
                            : t('segments.days', { count: Math.round(s.avgRecencyDays) })}
                        </td>
                        <td className="hidden px-4 py-3 text-right tabular-nums md:table-cell">
                          {s.avgOrders === null ? '—' : s.avgOrders.toFixed(1)}
                        </td>
                        <td className="hidden px-4 py-3 text-right tabular-nums lg:table-cell">
                          {s.avgClvCents === null
                            ? '—'
                            : formatMoney(Math.round(s.avgClvCents), currency)}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td className="px-4 py-3">
                        <Link
                          to="/customers?segment=no_purchases"
                          className="font-medium text-ink-muted hover:text-accent"
                        >
                          {t('segments.noPurchases')}
                        </Link>
                        <p className="mt-0.5 text-xs text-ink-subtle">
                          {t('segments.noPurchasesHint')}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-ink-muted">
                        {formatNumber(data.noPurchases)}
                      </td>
                      <td colSpan={4} />
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>
            <Card>
              <h2 className="text-sm font-semibold">{t('segments.matrixTitle')}</h2>
              <p className="mb-2 mt-1 text-xs text-ink-muted">{t('segments.matrixHint')}</p>
              <EChart option={heatmap} ariaLabel={t('segments.matrixTitle')} height={320} />
            </Card>
          </div>
          <p className="mt-3 text-xs text-ink-subtle">
            {t('segments.revenueNote', { days: data.lookbackDays })}
          </p>
        </>
      )}
    </>
  );
}
