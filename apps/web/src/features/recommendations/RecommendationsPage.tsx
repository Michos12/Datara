import { PRIORITIES, type Priority, type RecommendationStatus } from '@ci/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { Alert, SelectField } from '../../components/forms';
import { Card, PageHeader } from '../../components/PageHeader';
import { useSession } from '../auth/AuthProvider';
import { useRecommendations } from './queries';
import { RecommendationCard } from './RecommendationCard';

const VIEWS: Record<string, RecommendationStatus[]> = {
  open: ['open', 'acknowledged'],
  done: ['done'],
  dismissed: ['dismissed'],
  expired: ['expired'],
};
type View = keyof typeof VIEWS;

/** Recommendations inbox (REC-01 … 05): highest priority score first. */
export function RecommendationsPage() {
  const { t } = useTranslation();
  const { currency } = useSession().organization;
  const [search, setSearch] = useSearchParams();
  const requested = search.get('view') ?? 'open';
  const view: View = requested in VIEWS ? requested : 'open';
  const [priority, setPriority] = useState<Priority | ''>('');
  const list = useRecommendations(VIEWS[view]!, priority);

  return (
    <>
      <PageHeader
        title={t('recommendations.title')}
        description={t('recommendations.description')}
      />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div role="tablist" aria-label={t('recommendations.viewsLabel')} className="flex gap-1">
          {Object.keys(VIEWS).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              onClick={() => setSearch({ view: key }, { replace: true })}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                view === key
                  ? 'bg-accent-soft text-accent'
                  : 'text-ink-muted hover:bg-surface-muted'
              }`}
            >
              {t(`recommendations.views.${key}`)}
            </button>
          ))}
        </div>
        <div className="w-48">
          <SelectField
            label={t('recommendations.priority')}
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority | '')}
            options={[
              { value: '', label: t('recommendations.allPriorities') },
              ...PRIORITIES.map((p) => ({ value: p, label: t(`recommendations.priorities.${p}`) })),
            ]}
          />
        </div>
      </div>

      {list.isError && <Alert tone="error">{t('errors.generic')}</Alert>}
      {list.isPending ? (
        <div className="h-40 animate-pulse rounded-xl bg-surface-muted" />
      ) : list.data && list.data.data.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-muted">{t('recommendations.empty')}</p>
        </Card>
      ) : (
        <ul className="grid gap-3" aria-label={t('recommendations.title')}>
          {list.data?.data.map((r) => (
            <RecommendationCard key={r.id} recommendation={r} currency={currency} />
          ))}
        </ul>
      )}
    </>
  );
}
