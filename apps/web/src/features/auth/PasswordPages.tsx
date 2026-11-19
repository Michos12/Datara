import { PASSWORD_MIN_LENGTH } from '@ci/contracts';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Alert, Button, TextField } from '../../components/forms';
import { ApiError, apiRequest } from '../../lib/api';
import { AuthLayout } from './AuthLayout';

/** Reads the single-use token from the URL fragment (never sent to servers or in Referer). */
export function tokenFromHash(hash = window.location.hash): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token');
}

function BackToSignIn() {
  const { t } = useTranslation();
  return (
    <Link to="/login" className="font-medium text-accent hover:underline">
      {t('auth.backToSignIn')}
    </Link>
  );
}

export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiRequest('POST', '/auth/password/forgot', { body: { email } });
      setSent(email);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('errors.network'));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title={t('auth.forgotTitle')}
      subtitle={t('auth.forgotSubtitle')}
      footer={<BackToSignIn />}
    >
      {sent ? (
        <Alert tone="success">{t('auth.forgotSent', { email: sent })}</Alert>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          <TextField
            label={t('auth.email')}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" disabled={pending || !email}>
            {pending ? t('auth.sending') : t('auth.sendLink')}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const { t } = useTranslation();
  const [token] = useState(() => tokenFromHash());
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldError(undefined);
    setPending(true);
    try {
      await apiRequest('POST', '/auth/password/reset', { body: { token, newPassword: password } });
      setDone(true);
      window.history.replaceState(null, '', window.location.pathname);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldError(err.fieldErrors.newPassword);
        if (!err.fieldErrors.newPassword) setError(err.message);
      } else setError(t('errors.network'));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout title={t('auth.resetTitle')} footer={<BackToSignIn />}>
      {!token ? (
        <Alert tone="error">{t('auth.linkMissing')}</Alert>
      ) : done ? (
        <Alert tone="success">{t('auth.resetDone')}</Alert>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          <TextField
            label={t('auth.newPassword')}
            type="password"
            autoComplete="new-password"
            required
            value={password}
            hint={t('auth.passwordHint', { min: PASSWORD_MIN_LENGTH })}
            error={fieldError}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" disabled={pending || !password}>
            {t('auth.resetSubmit')}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
