import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/forms';
import { useAuth, useSession } from '../features/auth/AuthProvider';

/** Signed-in user, active organization and role, with sign-out. */
export function UserMenu() {
  const { t } = useTranslation();
  const session = useSession();
  const { logout, switchOrganization } = useAuth();
  const [pending, setPending] = useState(false);

  return (
    <div className="flex items-center gap-3">
      {session.memberships.length > 1 && (
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <span className="sr-only">{t('auth.switchOrganization')}</span>
          <select
            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink"
            value={session.organization.id}
            disabled={pending}
            onChange={async (e) => {
              setPending(true);
              try {
                await switchOrganization(e.target.value);
              } finally {
                setPending(false);
              }
            }}
          >
            {session.memberships.map((m) => (
              <option key={m.organizationId} value={m.organizationId}>
                {m.organizationName}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="hidden text-right sm:block">
        <p className="text-sm font-medium leading-tight">{session.user.fullName}</p>
        <p className="text-xs leading-tight text-ink-muted">
          {session.organization.name} · {t(`roles.${session.role}`)}
        </p>
      </div>
      <Button
        variant="ghost"
        className="px-3 py-1.5"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          await logout();
        }}
      >
        {t('auth.signOut')}
      </Button>
    </div>
  );
}
