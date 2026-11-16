import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';
import { Logo } from '../components/Logo';
import { SystemStatus } from '../features/status/SystemStatus';
import { NAV_SECTIONS } from './navigation';
import { UserMenu } from './UserMenu';

export function AppShell() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        {t('app.skipToContent')}
      </a>

      <aside className="border-line bg-surface md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:border-r">
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-6 md:border-b-0">
          <Logo />
          <span className="text-[15px] font-semibold tracking-tight">{t('app.name')}</span>
        </div>
        <nav aria-label="Main" className="overflow-x-auto px-3 pb-3 md:pb-6">
          <div className="flex gap-1 md:flex-col md:gap-5">
            {NAV_SECTIONS.map((section) => (
              <div key={section.key} className="flex gap-1 md:flex-col">
                <p className="hidden px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-ink-subtle md:block">
                  {t(`nav.sections.${section.key}`)}
                </p>
                {section.items.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    end={item.path === '/'}
                    className={({ isActive }) =>
                      `whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors ${
                        isActive
                          ? 'bg-accent-soft font-medium text-accent'
                          : 'text-ink-muted hover:bg-surface-muted hover:text-ink'
                      }`
                    }
                  >
                    {t(`nav.${item.key}`)}
                  </NavLink>
                ))}
              </div>
            ))}
          </div>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-4 border-b border-line bg-surface px-4 md:px-8">
          <SystemStatus />
          <UserMenu />
        </header>
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 md:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
