import { useTranslation } from 'react-i18next';
import { Card } from '../../components/PageHeader';
import { downloadCsv } from '../../lib/csv';
import { formatNumber, formatPercent } from '../../lib/format';
import { PanelHeading, QueryNotices } from '../behavior/shared';
import { useJourney, type ValueFilters } from './queries';

/** Lifecycle funnel (became a customer → 1st → 2nd → 3rd+ purchase, still active). */
export function JourneyPanel({ filters }: { filters: ValueFilters }) {
  const { t } = useTranslation();
  const query = useJourney(filters);
  const data = query.data?.data;

  if (query.isPending) return <div className="h-64 animate-pulse rounded-lg bg-surface-muted" />;
  if (!data) return <QueryNotices error={query.error} warnings={undefined} />;
  const top = Math.max(data.stages[0]?.customers ?? 0, 1);

  function download() {
    downloadCsv(
      `journey-${filters.range.start}-${filters.range.end}.csv`,
      ['stage', 'customers', 'conversion', 'ci_low', 'ci_high'],
      data!.stages.map((s) => [
        s.stage,
        s.customers,
        s.conversion?.rate ?? null,
        s.conversion?.low ?? null,
        s.conversion?.high ?? null,
      ]),
    );
  }

  return (
    <>
      <QueryNotices error={query.error} warnings={query.data?.meta.warnings} />
      <Card>
        <PanelHeading
          title={t('value.journey.funnel')}
          explain={t('value.journey.funnelHint')}
          onDownload={download}
        />
        <ol className="space-y-3" aria-label={t('value.journey.funnel')}>
          {data.stages.map((stage) => {
            const width = Math.max((stage.customers / top) * 100, stage.customers ? 1.5 : 0);
            const rate = stage.conversion?.rate;
            return (
              <li key={stage.stage}>
                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium">{t(`value.journey.stages.${stage.stage}`)}</span>
                  <span className="tabular-nums">
                    {formatNumber(stage.customers)}
                    {rate !== undefined && rate !== null && (
                      <span className="ml-2 text-xs text-ink-muted">
                        {t(
                          stage.stage === 'active'
                            ? 'value.journey.fromFirst'
                            : 'value.journey.fromPrevious',
                          { rate: formatPercent(rate, { digits: 0 }) },
                        )}
                      </span>
                    )}
                  </span>
                </div>
                <div className="h-3 rounded-full bg-surface-muted" aria-hidden="true">
                  <div
                    className={`h-3 rounded-full ${stage.stage === 'active' ? 'bg-[var(--color-chart-3)]' : 'bg-accent'}`}
                    style={{ width: `${width}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      </Card>

      <Card className="mt-4">
        <PanelHeading title={t('value.journey.timing')} explain={t('value.journey.timingHint')} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('value.journey.timing')}</caption>
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
                <th scope="col" className="py-2 font-medium">
                  {t('value.journey.step')}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t('value.journey.reached')}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t('value.journey.waiting')}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t('value.journey.medianDays')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.timing.map((row) => (
                <tr key={row.to}>
                  <th scope="row" className="py-2 text-left font-normal">
                    {t(`value.journey.stages.${row.from}`)} → {t(`value.journey.stages.${row.to}`)}
                  </th>
                  <td className="py-2 text-right tabular-nums">{formatNumber(row.reached)}</td>
                  <td className="py-2 text-right tabular-nums text-ink-muted">
                    {formatNumber(row.censored)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {row.medianDays === null
                      ? t('value.notReached')
                      : t('value.days', { count: row.medianDays })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-4">
        <PanelHeading title={t('value.journey.before')} explain={t('value.journey.beforeHint')} />
        {data.beforeFirstPurchase.types.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('value.journey.noInteractions')}</p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">{t('value.journey.before')}</caption>
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
                <th scope="col" className="py-2 font-medium">
                  {t('value.journey.type')}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t('value.journey.customers')}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t('value.journey.share')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.beforeFirstPurchase.types.map((row) => (
                <tr key={row.type}>
                  <th scope="row" className="py-2 text-left font-normal">
                    {t(`interactions.types.${row.type}`)}
                  </th>
                  <td className="py-2 text-right tabular-nums">{formatNumber(row.customers)}</td>
                  <td className="py-2 text-right tabular-nums">
                    {formatPercent(row.share, { digits: 0 })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
