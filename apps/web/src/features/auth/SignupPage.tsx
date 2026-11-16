import { INDUSTRIES, PASSWORD_MIN_LENGTH, signupRequestSchema, type Industry } from '@ci/contracts';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Alert, Button, issuesToFieldErrors, SelectField, TextField } from '../../components/forms';
import { ApiError } from '../../lib/api';
import { browserTimezone, currencyOptions, guessCurrency, timezoneOptions } from '../../lib/intl';
import { useAuth } from './AuthProvider';
import { AuthLayout } from './AuthLayout';

export function SignupPage() {
  const { t } = useTranslation();
  const { signup } = useAuth();
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    password: '',
    organizationName: '',
    timezone: browserTimezone(),
    currency: guessCurrency(),
    industry: 'retail' as Industry,
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const timezones = useMemo(timezoneOptions, []);
  const currencies = useMemo(() => currencyOptions(), []);
  const industries = INDUSTRIES.map((value) => ({ value, label: t(`industries.${value}`) }));

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const parsed = signupRequestSchema.safeParse({
      email: form.email,
      password: form.password,
      fullName: form.fullName,
      organization: {
        name: form.organizationName,
        timezone: form.timezone,
        currency: form.currency,
        industry: form.industry,
      },
    });
    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    setPending(true);
    try {
      await signup(parsed.data);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setError(err.message);
      } else {
        setError(t('errors.network'));
      }
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title={t('auth.signUpTitle')}
      subtitle={t('auth.signUpSubtitle')}
      footer={
        <>
          {t('auth.haveAccount')}{' '}
          <Link to="/login" className="font-medium text-accent hover:underline">
            {t('auth.signIn')}
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error && <Alert tone="error">{error}</Alert>}
        <TextField
          label={t('auth.fullName')}
          autoComplete="name"
          value={form.fullName}
          onChange={(e) => set('fullName')(e.target.value)}
          error={fieldErrors.fullName}
        />
        <TextField
          label={t('auth.email')}
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={(e) => set('email')(e.target.value)}
          error={fieldErrors.email}
        />
        <TextField
          label={t('auth.password')}
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={(e) => set('password')(e.target.value)}
          hint={t('auth.passwordHint', { min: PASSWORD_MIN_LENGTH })}
          error={fieldErrors.password}
        />
        <hr className="border-line" />
        <TextField
          label={t('auth.organizationName')}
          autoComplete="organization"
          value={form.organizationName}
          onChange={(e) => set('organizationName')(e.target.value)}
          error={fieldErrors['organization.name']}
        />
        <SelectField
          label={t('auth.industry')}
          value={form.industry}
          onChange={(e) => set('industry')(e.target.value)}
          options={industries}
          hint={t('auth.industryHint')}
          error={fieldErrors['organization.industry']}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label={t('auth.timezone')}
            value={form.timezone}
            onChange={(e) => set('timezone')(e.target.value)}
            options={timezones}
            hint={t('auth.timezoneHint')}
            error={fieldErrors['organization.timezone']}
          />
          <SelectField
            label={t('auth.currency')}
            value={form.currency}
            onChange={(e) => set('currency')(e.target.value)}
            options={currencies}
            hint={t('auth.currencyHint')}
            error={fieldErrors['organization.currency']}
          />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? t('auth.creating') : t('auth.createAccount')}
        </Button>
      </form>
    </AuthLayout>
  );
}
