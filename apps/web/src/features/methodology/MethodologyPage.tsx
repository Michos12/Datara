import { useTranslation } from 'react-i18next';
import { Card, PageHeader } from '../../components/PageHeader';
import { useSession } from '../auth/AuthProvider';
import { useDefinitions } from '../overview/queries';

/** Every metric's definition, rendered from the analytics service's registry (PLT-04). */
export function MethodologyPage() {
  const { t } = useTranslation();
  const definitions = useDefinitions();
  const { settings, timezone } = useSession().organization;

  return (
    <>
      <PageHeader title={t('methodology.title')} description={t('methodology.description')} />
      <Card className="mb-6">
        <h2 className="text-sm font-semibold">{t('methodology.yourSettings')}</h2>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="inline text-ink-muted">{t('auth.timezone')}: </dt>
            <dd className="inline">{timezone}</dd>
          </div>
          <div>
            <dt className="inline text-ink-muted">{t('settings.activeWindowDays')}: </dt>
            <dd className="inline">{settings.activeWindowDays}</dd>
          </div>
          <div>
            <dt className="inline text-ink-muted">{t('settings.churnDays')}: </dt>
            <dd className="inline">{settings.churnDays}</dd>
          </div>
          <div>
            <dt className="inline text-ink-muted">{t('settings.weekStart')}: </dt>
            <dd className="inline">{t(`settings.${settings.weekStart}`)}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-ink-subtle">{t('methodology.rules')}</p>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        {[...(definitions.data?.values() ?? [])].map((d) => (
          <Card key={d.key}>
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-sm font-semibold">{d.name}</h2>
              <span className="whitespace-nowrap rounded-full bg-surface-muted px-2 py-0.5 text-xs text-ink-muted">
                v{d.version} · {t(`overview.kind.${d.kind}`)}
              </span>
            </div>
            <p className="mt-2 text-sm">{d.description}</p>
            <p className="mt-2 text-xs text-ink-muted">{d.formula}</p>
            <p className="mt-1 text-xs text-ink-subtle">{d.period_rule}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
