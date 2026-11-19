import {
  invitationListSchema,
  invitationSchema,
  memberListSchema,
  ROLES,
  type Member,
  type Role,
} from '@ci/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, SelectField, TextField } from '../../components/forms';
import { Card, PageHeader } from '../../components/PageHeader';
import { ApiError, apiGet, apiRequest } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useAuth, useSession } from '../auth/AuthProvider';

const keys = {
  members: ['team', 'members'] as const,
  invitations: ['team', 'invitations'] as const,
};

/** Members, roles and invitations (AUTH-04). Owners and admins only. */
export function TeamPage() {
  const { t } = useTranslation();
  const session = useSession();
  const canManage = session.role === 'OWNER' || session.role === 'ADMIN';
  return (
    <>
      <PageHeader title={t('team.title')} description={t('team.description')} />
      {canManage ? (
        <div className="grid gap-6">
          <MembersCard />
          <InviteCard />
          <InvitationsCard />
        </div>
      ) : (
        <Alert tone="info">{t('team.readOnly')}</Alert>
      )}
    </>
  );
}

function roleOptions(t: (key: string) => string, isOwner: boolean) {
  return ROLES.filter((r) => isOwner || r !== 'OWNER').map((r) => ({
    value: r,
    label: t(`roles.${r}`),
  }));
}

function MembersCard() {
  const { t } = useTranslation();
  const session = useSession();
  const { logout } = useAuth();
  const client = useQueryClient();
  const isOwner = session.role === 'OWNER';
  const members = useQuery({
    queryKey: keys.members,
    queryFn: ({ signal }) => apiGet('/organization/members', { schema: memberListSchema, signal }),
  });
  const [error, setError] = useState<string | null>(null);
  const onError = (err: unknown) =>
    setError(err instanceof ApiError ? err.message : t('errors.network'));

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      apiRequest('PATCH', `/organization/members/${userId}`, { body: { role } }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.members }),
    onError,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => apiRequest('DELETE', `/organization/members/${userId}`),
    onSuccess: async (_data, userId) => {
      if (userId === session.user.id) await logout();
      else await client.invalidateQueries({ queryKey: keys.members });
    },
    onError,
  });

  function confirmRemove(m: Member) {
    if (window.confirm(t('team.removeConfirm', { name: m.fullName }))) remove.mutate(m.userId);
  }

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold">{t('team.members')}</h2>
      {error && (
        <div className="mb-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('team.members')}</caption>
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
              <th scope="col" className="py-2 font-medium">
                {t('team.name')}
              </th>
              <th scope="col" className="py-2 font-medium">
                {t('team.role')}
              </th>
              <th scope="col" className="py-2 font-medium">
                {t('team.lastLogin')}
              </th>
              <th scope="col" className="py-2">
                <span className="sr-only">{t('team.remove')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {members.data?.data.map((m) => {
              const self = m.userId === session.user.id;
              const locked = !isOwner && m.role === 'OWNER';
              return (
                <tr key={m.userId}>
                  <th scope="row" className="py-2 text-left font-normal">
                    <span className="font-medium">{m.fullName}</span>
                    {self && <span className="ml-1 text-ink-muted">({t('team.you')})</span>}
                    <span className="block text-xs text-ink-muted">{m.email}</span>
                  </th>
                  <td className="py-2">
                    <select
                      aria-label={`${t('team.role')}: ${m.fullName}`}
                      className="rounded-lg border border-line bg-surface px-2 py-1 text-sm disabled:opacity-60"
                      value={m.role}
                      disabled={locked || changeRole.isPending}
                      onChange={(e) =>
                        changeRole.mutate({ userId: m.userId, role: e.target.value as Role })
                      }
                    >
                      {(locked ? ROLES : roleOptions(t, isOwner).map((o) => o.value)).map((r) => (
                        <option key={r} value={r}>
                          {t(`roles.${r}`)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 text-ink-muted">
                    {m.lastLoginAt ? formatDate(m.lastLoginAt) : t('team.never')}
                  </td>
                  <td className="py-2 text-right">
                    {!locked && (
                      <Button
                        variant="ghost"
                        className="px-2 py-1 text-xs"
                        onClick={() => confirmRemove(m)}
                      >
                        {self ? t('team.leave') : t('team.remove')}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function InviteCard() {
  const { t } = useTranslation();
  const session = useSession();
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('ANALYST');
  const [result, setResult] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const invite = useMutation({
    mutationFn: () =>
      apiRequest('POST', '/organization/invitations', {
        body: { email, role },
        schema: invitationSchema,
      }),
    onSuccess: async (created) => {
      setResult(
        created.emailSent === false
          ? { tone: 'error', message: t('team.inviteNotSent') }
          : { tone: 'success', message: t('team.invited', { email: created.email }) },
      );
      setEmail('');
      await client.invalidateQueries({ queryKey: keys.invitations });
    },
    onError: (err) => {
      setFieldError(err instanceof ApiError ? err.fieldErrors.email : undefined);
      setResult({
        tone: 'error',
        message: err instanceof ApiError ? err.message : t('errors.network'),
      });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setResult(null);
    setFieldError(undefined);
    invite.mutate();
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold">{t('team.invite')}</h2>
      <p className="mb-3 mt-1 text-xs text-ink-muted">{t('team.inviteHint')}</p>
      {result && (
        <div className="mb-3">
          <Alert tone={result.tone}>{result.message}</Alert>
        </div>
      )}
      <form onSubmit={onSubmit} className="grid gap-3 md:grid-cols-[2fr_1fr_auto] md:items-end">
        <TextField
          label={t('team.email')}
          type="email"
          value={email}
          error={fieldError}
          onChange={(e) => setEmail(e.target.value)}
        />
        <SelectField
          label={t('team.role')}
          value={role}
          hint={t(`team.roleHints.${role}`)}
          onChange={(e) => setRole(e.target.value as Role)}
          options={roleOptions(t, session.role === 'OWNER')}
        />
        <Button type="submit" disabled={invite.isPending || !email}>
          {t('team.sendInvite')}
        </Button>
      </form>
    </Card>
  );
}

function InvitationsCard() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const invitations = useQuery({
    queryKey: keys.invitations,
    queryFn: ({ signal }) =>
      apiGet('/organization/invitations', { schema: invitationListSchema, signal }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/organization/invitations/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.invitations }),
  });
  const rows = invitations.data?.data ?? [];
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold">{t('team.pending')}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('team.noPending')}</p>
      ) : (
        <ul className="divide-y divide-line" aria-label={t('team.pending')}>
          {rows.map((inv) => (
            <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="text-sm">
                <span className="font-medium">{inv.email}</span>
                <span className="ml-2 text-ink-muted">{t(`roles.${inv.role}`)}</span>
                <span className="block text-xs text-ink-muted">
                  {t('team.expires', { date: formatDate(inv.expiresAt) })}
                  {inv.invitedBy && ` · ${t('team.by', { name: inv.invitedBy })}`}
                </span>
              </div>
              <Button
                variant="ghost"
                className="px-2 py-1 text-xs"
                onClick={() => revoke.mutate(inv.id)}
              >
                {t('team.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
