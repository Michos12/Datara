import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/forms';
import { useAuth, useSession } from '../features/auth/AuthProvider';

/** Signed-in user, active organization and role, with sign-out. */
export function UserMenu() {
  const { t } = useTranslation();
  const session = useSession();
  const { logout } = useAuth();
  const [pending, setPending] = useState(false);

  return (
    <div className="flex items-center gap-3">
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
