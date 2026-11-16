import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from './AuthProvider';

function FullPageLoader() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-full items-center justify-center" role="status" aria-live="polite">
      <p className="text-sm text-ink-muted">{t('auth.loading')}</p>
    </div>
  );
}

/** Renders children for signed-in users; otherwise sends them to /login and back afterwards. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') return <FullPageLoader />;
  if (state.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

/** Login and signup pages: signed-in users go straight to the app. */
export function RedirectIfAuthenticated({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') return <FullPageLoader />;
  if (state.status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from;
    return (
      <Navigate to={from && from.startsWith('/') && !from.startsWith('//') ? from : '/'} replace />
    );
  }
  return <>{children}</>;
}
