import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Alert, Button, TextField } from '../../components/forms';
import { ApiError } from '../../lib/api';
import { useAuth } from './AuthProvider';
import { AuthLayout } from './AuthLayout';

export function LoginPage() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await login({ email, password });
      // RedirectIfAuthenticated sends the user on to where they were going.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('errors.network'));
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title={t('auth.signInTitle')}
      footer={
        <>
          {t('auth.noAccount')}{' '}
          <Link to="/signup" className="font-medium text-accent hover:underline">
            {t('auth.createAccount')}
          </Link>
        </>
      }
    >
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
        <TextField
          label={t('auth.password')}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" disabled={pending || !email || !password}>
          {pending ? t('auth.signingIn') : t('auth.signIn')}
        </Button>
        <Link to="/forgot-password" className="text-center text-sm text-accent hover:underline">
          {t('auth.forgot')}
        </Link>
      </form>
    </AuthLayout>
  );
}
