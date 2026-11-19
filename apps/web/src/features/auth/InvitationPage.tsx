import {
  authResponseSchema,
  invitationPreviewSchema,
  PASSWORD_MIN_LENGTH,
  type InvitationPreview,
} from '@ci/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { Alert, Button, TextField } from '../../components/forms';
import { ApiError, apiRequest } from '../../lib/api';
import { useAuth } from './AuthProvider';
import { AuthLayout } from './AuthLayout';
import { tokenFromHash } from './PasswordPages';

/** Accepts an invitation (AUTH-04): existing accounts confirm their password, new ones sign up. */
export function InvitationPage() {
  const { t } = useTranslation();
  const { startSession } = useAuth();
  const navigate = useNavigate();
  const [token] = useState(() => tokenFromHash());
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!token) return;
    apiRequest('POST', '/invitations/preview', { body: { token }, schema: invitationPreviewSchema })
      .then(setPreview)
      .catch((err: unknown) =>
        setLoadError(err instanceof ApiError ? err.message : t('errors.network')),
      );
  }, [token, t]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setPending(true);
    try {
      const res = await apiRequest('POST', '/invitations/accept', {
        body: { token, password, ...(preview?.accountExists ? {} : { fullName }) },
        schema: authResponseSchema,
      });
      window.history.replaceState(null, '', window.location.pathname);
      startSession(res);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setError(err.message);
      } else setError(t('errors.network'));
      setPending(false);
    }
  }

  const footer = (
    <Link to="/login" className="font-medium text-accent hover:underline">
      {t('auth.backToSignIn')}
    </Link>
  );
  if (!token || loadError) {
    return (
      <AuthLayout title={t('auth.acceptInvitation')} footer={footer}>
        <Alert tone="error">{loadError ?? t('auth.linkMissing')}</Alert>
      </AuthLayout>
    );
  }
  if (!preview) {
    return (
      <AuthLayout title={t('auth.acceptInvitation')} footer={footer}>
        <p className="text-sm text-ink-muted">{t('auth.loading')}</p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title={t('auth.invitationTitle', { organization: preview.organizationName })}
      subtitle={t('auth.invitationSubtitle', {
        role: t(`roles.${preview.role}`),
        email: preview.email,
      })}
      footer={footer}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <p className="text-sm text-ink-muted">
          {preview.accountExists ? t('auth.invitationExisting') : t('auth.invitationNew')}
        </p>
        {error && <Alert tone="error">{error}</Alert>}
        {!preview.accountExists && (
          <TextField
            label={t('auth.fullName')}
            autoComplete="name"
            required
            value={fullName}
            error={fieldErrors.fullName}
            onChange={(e) => setFullName(e.target.value)}
          />
        )}
        <TextField
          label={t('auth.password')}
          type="password"
          autoComplete={preview.accountExists ? 'current-password' : 'new-password'}
          required
          value={password}
          error={fieldErrors.password}
          {...(preview.accountExists
            ? {}
            : { hint: t('auth.passwordHint', { min: PASSWORD_MIN_LENGTH }) })}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" disabled={pending || !password}>
          {pending ? t('auth.joining') : t('auth.acceptInvitation')}
        </Button>
      </form>
    </AuthLayout>
  );
}
