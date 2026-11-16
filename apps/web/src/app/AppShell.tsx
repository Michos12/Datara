import { NavLink, Outlet } from 'react-router';
import { SystemStatus } from '../features/status/SystemStatus';
import { NAV_SECTIONS } from './navigation';

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-3">
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden="true">
        <rect width="32" height="32" rx="7" className="fill-accent" />
        <rect x="7" y="17" width="4" height="8" rx="1" fill="#fff" />
        <rect x="14" y="12" width="4" height="13" rx="1" fill="#fff" />
        <rect x="21" y="7" width="4" height="18" rx="1" fill="#fff" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight">Customer Insights</span>
    </div>
  );
}

export function AppShell() {
  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>

      <aside className="border-line bg-surface md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:border-r">
        <div className="flex h-14 items-center border-b border-line md:border-b-0">
          <Logo />
        </div>
        <nav aria-label="Main" className="overflow-x-auto px-3 pb-3 md:pb-6">
          <div className="flex gap-1 md:flex-col md:gap-5">
            {NAV_SECTIONS.map((section) => (
              <div key={section.title} className="flex gap-1 md:flex-col">
                <p className="hidden px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-ink-subtle md:block">
                  {section.title}
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
                    {item.label}
                  </NavLink>
                ))}
              </div>
            ))}
          </div>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-end border-b border-line bg-surface px-4 md:px-8">
          <SystemStatus />
        </header>
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 md:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
