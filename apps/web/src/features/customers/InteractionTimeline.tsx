import {
  createInteractionRequestSchema,
  INTERACTION_TYPES,
  interactionPageSchema,
  interactionSchema,
  type InteractionType,
} from '@ci/contracts';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, issuesToFieldErrors, SelectField, TextField } from '../../components/forms';
import { Modal } from '../../components/Modal';
import { Card } from '../../components/PageHeader';
import { ApiError, apiGet, apiRequest } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { customerKeys } from './queries';

const interactionKeys = (customerId: string) => ['customers', 'interactions', customerId] as const;

function useInteractions(customerId: string) {
  return useInfiniteQuery({
    queryKey: interactionKeys(customerId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      apiGet(
        `/customers/${customerId}/interactions?limit=20${pageParam ? `&cursor=${pageParam}` : ''}`,
        { schema: interactionPageSchema, signal },
      ),
    getNextPageParam: (last) => last.page.nextCursor,
  });
}

/** A customer's interactions, newest first, with add (editors) and delete (admins). */
export function InteractionTimeline({
  customerId,
  timezone,
  canEdit,
  canDelete,
}: {
  customerId: string;
  timezone: string;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const list = useInteractions(customerId);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  async function remove(id: string) {
    if (!window.confirm(t('interactions.deleteConfirm'))) return;
    try {
      await apiRequest('DELETE', `/interactions/${id}`);
      await queryClient.invalidateQueries({ queryKey: interactionKeys(customerId) });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('errors.network'));
    }
  }

  return (
    <Card className="mt-6 overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">{t('interactions.title')}</h2>
        {canEdit && (
          <Button variant="secondary" className="px-3 py-1.5" onClick={() => setAdding(true)}>
            {t('interactions.add')}
          </Button>
        )}
      </div>
      {error && (
        <div className="px-4 pt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {list.isPending ? (
        <div className="m-4 h-16 animate-pulse rounded-lg bg-surface-muted" />
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-ink-muted">{t('interactions.empty')}</p>
      ) : (
        <ol className="divide-y divide-line" aria-label={t('interactions.title')}>
          {rows.map((row) => {
            const details = Object.entries(row.metadata)
              .map(([k, v]) => `${k}: ${String(v)}`)
              .join(' · ');
            return (
              <li key={row.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0 text-sm">
                  <p>
                    <span className="font-medium">{t(`interactions.types.${row.type}`)}</span>
                    {row.channel && <span className="text-ink-muted"> · {row.channel}</span>}
                  </p>
                  <p className="text-xs text-ink-muted">
                    <time dateTime={row.occurredAt}>
                      {formatDateTime(row.occurredAt, undefined, timezone)}
                    </time>
                    {details && <span className="ml-2 break-words">{details}</span>}
                  </p>
                </div>
                {canDelete && (
                  <Button
                    variant="ghost"
                    className="px-2 py-1 text-xs"
                    onClick={() => void remove(row.id)}
                    aria-label={`${t('interactions.delete')} ${t(`interactions.types.${row.type}`)}`}
                  >
                    {t('interactions.delete')}
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {list.hasNextPage && (
        <div className="border-t border-line p-2 text-center">
          <Button variant="ghost" onClick={() => void list.fetchNextPage()}>
            {t('interactions.loadMore')}
          </Button>
        </div>
      )}
      {adding && <InteractionFormDialog customerId={customerId} onClose={() => setAdding(false)} />}
    </Card>
  );
}

function InteractionFormDialog({
  customerId,
  onClose,
}: {
  customerId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const now = new Date();
  const localNow = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  const [draft, setDraft] = useState({
    type: 'email_clicked' as InteractionType,
    occurredAt: localNow,
    channel: '',
    note: '',
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const parsed = createInteractionRequestSchema.safeParse({
      customerId,
      type: draft.type,
      occurredAt: new Date(draft.occurredAt).toISOString(),
      channel: draft.channel || null,
      ...(draft.note.trim() ? { metadata: { note: draft.note.trim() } } : {}),
    });
    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setPending(true);
    try {
      await apiRequest('POST', '/interactions', { body: parsed.data, schema: interactionSchema });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: interactionKeys(customerId) }),
        queryClient.invalidateQueries({ queryKey: customerKeys.detail(customerId) }),
      ]);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setError(err.message);
      } else setError(t('errors.network'));
      setPending(false);
    }
  }

  return (
    <Modal title={t('interactions.add')} onClose={onClose}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label={t('interactions.type')}
            value={draft.type}
            onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value as InteractionType }))}
            options={INTERACTION_TYPES.map((type) => ({
              value: type,
              label: t(`interactions.types.${type}`),
            }))}
          />
          <TextField
            label={t('interactions.date')}
            type="datetime-local"
            value={draft.occurredAt}
            onChange={(e) => setDraft((d) => ({ ...d, occurredAt: e.target.value }))}
            error={fieldErrors.occurredAt}
          />
          <TextField
            label={t('interactions.channel')}
            value={draft.channel}
            placeholder="email"
            onChange={(e) => setDraft((d) => ({ ...d, channel: e.target.value }))}
            error={fieldErrors.channel}
          />
          <TextField
            label={t('interactions.details')}
            value={draft.note}
            maxLength={500}
            onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('customer.cancel')}
          </Button>
          <Button type="submit" disabled={pending}>
            {t('interactions.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
