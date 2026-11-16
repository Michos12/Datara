import { useTranslation } from 'react-i18next';
import { isRouteErrorResponse, useRouteError, type RouteObject } from 'react-router';
import { Card, PageHeader } from '../components/PageHeader';
import { RedirectIfAuthenticated, RequireAuth } from '../features/auth/guards';
import { LoginPage } from '../features/auth/LoginPage';
import { SignupPage } from '../features/auth/SignupPage';
import { ComingSoonPage } from '../features/placeholder/ComingSoonPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { AppShell } from './AppShell';
import { NAV_ITEMS } from './navigation';

function NotFound() {
  return <ErrorView notFound />;
}

function RouteError() {
  const error = useRouteError();
  return <ErrorView notFound={isRouteErrorResponse(error) && error.status === 404} />;
}

function ErrorView({ notFound }: { notFound: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={notFound ? 'Page not found' : 'Something went wrong'} />
      <Card>
        <p className="text-sm text-ink-muted">
          {notFound ? 'The page you are looking for does not exist.' : t('errors.generic')}
        </p>
      </Card>
    </>
  );
}

const PAGES_BUILT = new Set(['/', '/settings']);

export const routes: RouteObject[] = [
  {
    path: '/login',
    element: (
      <RedirectIfAuthenticated>
        <LoginPage />
      </RedirectIfAuthenticated>
    ),
  },
  {
    path: '/signup',
    element: (
      <RedirectIfAuthenticated>
        <SignupPage />
      </RedirectIfAuthenticated>
    ),
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      {
        errorElement: <RouteError />,
        children: [
          {
            index: true,
            // Chart-heavy pages load on demand so ECharts stays out of the initial bundle.
            lazy: () =>
              import('../features/overview/OverviewPage').then((m) => ({
                Component: m.OverviewPage,
              })),
          },
          { path: 'settings', element: <SettingsPage /> },
          ...NAV_ITEMS.filter((item) => !PAGES_BUILT.has(item.path)).map((item) => ({
            path: item.path.slice(1),
            element: <ComingSoonPage item={item} />,
          })),
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
];
