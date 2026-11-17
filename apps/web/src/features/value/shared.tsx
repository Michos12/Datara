import { useTranslation } from 'react-i18next';

export function cohortLabel(cohort: string, locale?: string) {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${cohort}-01T00:00:00Z`));
}

/** A cell that cannot be measured yet (the horizon has not passed): never shown as 0. */
export function NotYet() {
  const { t } = useTranslation();
  return (
    <span className="text-ink-subtle" title={t('value.notYet')}>
      <span aria-hidden="true">·</span>
      <span className="sr-only">{t('value.notYet')}</span>
    </span>
  );
}

export function LowSampleMark() {
  const { t } = useTranslation();
  return (
    <span className="ml-1 text-warning" title={t('value.lowSample')}>
      *<span className="sr-only">{t('value.lowSample')}</span>
    </span>
  );
}
