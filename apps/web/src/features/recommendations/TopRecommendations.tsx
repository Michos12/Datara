import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Card } from '../../components/PageHeader';
import { useRecommendations } from './queries';
import { RecommendationCard } from './RecommendationCard';

/** The three open recommendations with the highest priority score, on the overview. */
export function TopRecommendations({ currency }: { currency: string }) {
  const { t } = useTranslation();
  const list = useRecommendations(['open', 'acknowledged'], '', 3);
  if (list.isError || list.isPending) return null;
  return (
    <Card className="mt-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t('recommendations.top')}</h2>
        <Link to="/recommendations" className="text-sm text-accent hover:underline">
          {t('recommendations.viewAll')}
        </Link>
      </div>
      {list.data.data.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('recommendations.noneOpen')}</p>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-3" aria-label={t('recommendations.top')}>
          {list.data.data.map((r) => (
            <RecommendationCard key={r.id} recommendation={r} currency={currency} compact />
          ))}
        </ul>
      )}
    </Card>
  );
}
