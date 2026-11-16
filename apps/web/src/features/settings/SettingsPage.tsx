import {
  GRAINS,
  INDUSTRIES,
  INDUSTRY_PRESETS,
  organizationSchema,
  updateOrganizationRequestSchema,
  WEEK_STARTS,
  type Industry,
  type OrganizationSettings,
} from '@ci/contracts';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, issuesToFieldErrors, SelectField, TextField } from '../../components/forms';
import { Card, PageHeader } from '../../components/PageHeader';
import { ApiError, apiRequest } from '../../lib/api';
import { timezoneOptions } from '../../lib/intl';
import { useAuth, useSession } from '../auth/AuthProvider';

type Draft = {
  name: string;
  timezone: string;
  industry: Industry;
  settings: OrganizationSettings;
};

export function SettingsPage() {
  const { t } = useTranslation();
  const session = useSession();
  const { updateOrganization } = useAuth();
  const org = session.organization;
  const canEdit = session.role === 'OWNER' || session.role === 'ADMIN';

  const [draft, setDraft] = useState<Draft>({
    name: org.name,
    timezone: org.timezone,
    industry: org.industry,
    settings: org.settings,
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [pending, setPending] = useState(false);
  const timezones = useMemo(timezoneOptions, []);

  const setSetting = <K extends keyof OrganizationSettings>(
    key: K,
    value: OrganizationSettings[K],
  ) => setDraft((d) => ({ ...d, settings: { ...d.settings, [key]: value } }));

  const setCutPoint = (index: number, value: number) =>
    setDraft((d) => {
      const points = [...d.settings.recencyCutPoints] as OrganizationSettings['recencyCutPoints'];
      points[index] = value;
      return { ...d, settings: { ...d.settings, recencyCutPoints: points } };
    });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setResult(null);
    const parsed = updateOrganizationRequestSchema.safeParse(draft);
    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    setPending(true);
    try {
      const updated = await apiRequest('PATCH', '/organization', {
        body: parsed.data,
        schema: organizationSchema,
      });
      updateOrganization(updated);
      setResult({ tone: 'success', message: t('settings.saved') });
    } catch (err) {
      if (err instanceof ApiError) setFieldErrors(err.fieldErrors);
      setResult({
        tone: 'error',
        message: err instanceof ApiError ? err.message : t('errors.network'),
      });
    } finally {
      setPending(false);
    }
  }

  const numberField = (key: 'activeWindowDays' | 'churnDays', hint: string) => (
    <TextField
      label={t(`settings.${key}`)}
      type="number"
      inputMode="numeric"
      min={1}
      value={draft.settings[key]}
      onChange={(e) => setSetting(key, Number(e.target.value))}
      hint={hint}
      error={fieldErrors[`settings.${key}`]}
      disabled={!canEdit}
    />
  );

  return (
    <>
      <PageHeader title={t('settings.title')} description={t('settings.description')} />
      <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
        {!canEdit && <Alert tone="info">{t('settings.readOnly')}</Alert>}
        {result && <Alert tone={result.tone}>{result.message}</Alert>}

        <Card>
          <h2 className="mb-4 text-sm font-semibold">{t('settings.organization')}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              label={t('auth.organizationName')}
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              error={fieldErrors.name}
              disabled={!canEdit}
            />
            <SelectField
              label={t('auth.industry')}
              value={draft.industry}
              onChange={(e) => setDraft((d) => ({ ...d, industry: e.target.value as Industry }))}
              options={INDUSTRIES.map((value) => ({ value, label: t(`industries.${value}`) }))}
              disabled={!canEdit}
            />
            <SelectField
              label={t('auth.timezone')}
              value={draft.timezone}
              onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value }))}
              options={timezones}
              hint={t('auth.timezoneHint')}
              error={fieldErrors.timezone}
              disabled={!canEdit}
            />
            <TextField
              label={t('auth.currency')}
              value={org.currency}
              hint={t('auth.currencyHint')}
              disabled
              readOnly
            />
          </div>
        </Card>

        <Card>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">{t('settings.analytics')}</h2>
              <p className="mt-1 max-w-xl text-xs text-ink-muted">
                {t('settings.analyticsDescription')}
              </p>
            </div>
            {canEdit && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setDraft((d) => ({ ...d, settings: INDUSTRY_PRESETS[d.industry] }))}
              >
                {t('settings.applyPreset', { industry: t(`industries.${draft.industry}`) })}
              </Button>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {numberField('activeWindowDays', t('settings.activeWindowHint'))}
            {numberField('churnDays', t('settings.churnHint'))}
            <SelectField
              label={t('settings.weekStart')}
              value={draft.settings.weekStart}
              onChange={(e) =>
                setSetting('weekStart', e.target.value as OrganizationSettings['weekStart'])
              }
              options={WEEK_STARTS.map((value) => ({ value, label: t(`settings.${value}`) }))}
              disabled={!canEdit}
            />
            <SelectField
              label={t('settings.defaultGrain')}
              value={draft.settings.defaultGrain}
              onChange={(e) =>
                setSetting('defaultGrain', e.target.value as OrganizationSettings['defaultGrain'])
              }
              options={GRAINS.map((value) => ({ value, label: t(`settings.${value}`) }))}
              disabled={!canEdit}
            />
          </div>
          <fieldset className="mt-4">
            <legend className="text-sm font-medium">{t('settings.recencyCutPoints')}</legend>
            <div className="mt-1.5 grid grid-cols-4 gap-2">
              {draft.settings.recencyCutPoints.map((value, index) => (
                <input
                  key={index}
                  type="number"
                  inputMode="numeric"
                  aria-label={`${t('settings.recencyCutPoints')} ${index + 1}`}
                  className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm disabled:opacity-60"
                  value={value}
                  onChange={(e) => setCutPoint(index, Number(e.target.value))}
                  disabled={!canEdit}
                />
              ))}
            </div>
            <p className="mt-1.5 text-xs text-ink-subtle">
              {fieldErrors['settings.recencyCutPoints'] ?? t('settings.recencyHint')}
            </p>
          </fieldset>
        </Card>

        {canEdit && (
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? t('settings.saving') : t('settings.save')}
            </Button>
          </div>
        )}
      </form>
    </>
  );
}
