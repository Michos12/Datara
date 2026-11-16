import { isRouteErrorResponse, useRouteError, type RouteObject } from 'react-router';
import { Card, PageHeader } from '../components/PageHeader';
import { ComingSoonPage } from '../features/placeholder/ComingSoonPage';
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
  return (
    <>
      <PageHeader title={notFound ? 'Page not found' : 'Something went wrong'} />
      <Card>
        <p className="text-sm text-ink-muted">
          {notFound
            ? 'The page you are looking for does not exist.'
            : 'An unexpected error occurred. Try reloading the page.'}
        </p>
      </Card>
    </>
  );
}

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
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
          ...NAV_ITEMS.filter((item) => item.path !== '/').map((item) => ({
            path: item.path.slice(1),
            element: <ComingSoonPage item={item} />,
          })),
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
];
