import type { Priority, Recommendation } from '@ci/contracts';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { formatMoney, formatNumber } from '../../lib/format';

const PRIORITY_STYLES: Record<Priority, string> = {
  high: 'bg-negative/10 text-negative',
  medium: 'bg-warning/10 text-warning',
  low: 'bg-surface-muted text-ink-muted',
};

export function PriorityBadge({ priority }: { priority: Priority }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLES[priority]}`}
    >
      {t('recommendations.priority')}: {t(`recommendations.priorities.${priority}`)}
    </span>
  );
}

/** One recommendation in the inbox or on the overview. */
export function RecommendationCard({
  recommendation: r,
  currency,
  compact = false,
}: {
  recommendation: Recommendation;
  currency: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <li className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <PriorityBadge priority={r.priority} />
        <span>{t(`recommendations.rules.${r.ruleKey}`)}</span>
        {r.status !== 'open' && (
          <span className="rounded-full bg-surface-muted px-2 py-0.5">
            {t(`recommendations.statuses.${r.status}`)}
          </span>
        )}
      </div>
      <h3 className="mt-2 text-sm font-semibold">
        <Link to={`/recommendations/${r.id}`} className="hover:text-accent hover:underline">
          {r.title}
        </Link>
      </h3>
      {!compact && <p className="mt-1 text-sm text-ink-muted">{r.opportunity}</p>}
      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
        <div className="flex gap-1">
          <dt className="sr-only">{t('recommendations.metricLabels.affectedCustomers')}</dt>
          <dd>{t('recommendations.affected', { count: formatNumber(r.affectedCustomers) })}</dd>
        </div>
        {r.revenueAtStakeCents !== null && (
          <div className="flex gap-1">
            <dt>{t('recommendations.revenueAtStake')}:</dt>
            <dd className="font-medium text-ink">{formatMoney(r.revenueAtStakeCents, currency)}</dd>
          </div>
        )}
      </dl>
    </li>
  );
}
