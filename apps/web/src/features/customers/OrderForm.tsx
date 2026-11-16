import {
  createOrderRequestSchema,
  ORDER_STATUSES,
  orderSchema,
  type OrderStatus,
} from '@ci/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, issuesToFieldErrors, SelectField, TextField } from '../../components/forms';
import { Modal } from '../../components/Modal';
import { ApiError, apiRequest } from '../../lib/api';
import { formatMoney, parseMoneyInput } from '../../lib/format';
import { customerKeys } from './queries';

const AMOUNTS = ['gross', 'discount', 'tax', 'refunded'] as const;

/** Adds an order to a customer. Amounts are typed in major units and sent as minor units. */
export function OrderFormDialog({
  customerId,
  currency,
  onClose,
}: {
  customerId: string;
  currency: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const now = new Date();
  const localNow = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  const [draft, setDraft] = useState({
    orderedAt: localNow,
    status: 'completed' as OrderStatus,
    channel: '',
    externalId: '',
    gross: '',
    discount: '',
    tax: '',
    refunded: '',
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const cents = (key: (typeof AMOUNTS)[number]) =>
    draft[key].trim() === '' ? (key === 'gross' ? null : 0) : parseMoneyInput(draft[key], currency);
  const amounts = Object.fromEntries(AMOUNTS.map((k) => [k, cents(k)])) as Record<
    (typeof AMOUNTS)[number],
    number | null
  >;
  const net =
    amounts.gross !== null && amounts.discount !== null && amounts.refunded !== null
      ? amounts.gross - amounts.discount - amounts.refunded
      : null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const invalid = AMOUNTS.filter(
      (k) => amounts[k] === null && (k === 'gross' || draft[k].trim() !== ''),
    );
    if (invalid.length > 0) {
      setFieldErrors(
        Object.fromEntries(invalid.map((k) => [`${k}Cents`, t('order.invalidAmount')])),
      );
      return;
    }
    const parsed = createOrderRequestSchema.safeParse({
      customerId,
      orderedAt: new Date(draft.orderedAt).toISOString(),
      status: draft.status,
      channel: draft.channel || null,
      externalId: draft.externalId || null,
      grossCents: amounts.gross,
      discountCents: amounts.discount,
      taxCents: amounts.tax,
      refundedCents: amounts.refunded,
    });
    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    setPending(true);
    try {
      await apiRequest('POST', '/orders', { body: parsed.data, schema: orderSchema });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: customerKeys.detail(customerId) }),
        queryClient.invalidateQueries({ queryKey: customerKeys.orders(customerId) }),
        queryClient.invalidateQueries({ queryKey: ['customers', 'list'] }),
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
    <Modal title={t('customer.addOrder')} onClose={onClose}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t('order.date')}
            type="datetime-local"
            value={draft.orderedAt}
            onChange={(e) => setDraft((d) => ({ ...d, orderedAt: e.target.value }))}
            error={fieldErrors.orderedAt}
          />
          <SelectField
            label={t('order.status')}
            value={draft.status}
            onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value as OrderStatus }))}
            options={ORDER_STATUSES.map((s) => ({ value: s, label: t(`order.statuses.${s}`) }))}
          />
          {AMOUNTS.map((key) => (
            <TextField
              key={key}
              label={`${t(`order.${key}`)} (${currency})`}
              inputMode="decimal"
              placeholder={key === 'gross' ? '0.00' : '0'}
              value={draft[key]}
              onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
              error={fieldErrors[`${key}Cents`]}
            />
          ))}
          <TextField
            label={t('order.channel')}
            value={draft.channel}
            placeholder="online"
            onChange={(e) => setDraft((d) => ({ ...d, channel: e.target.value }))}
          />
          <TextField
            label={t('order.externalId')}
            value={draft.externalId}
            onChange={(e) => setDraft((d) => ({ ...d, externalId: e.target.value }))}
            error={fieldErrors.externalId}
          />
        </div>
        <p className="text-sm text-ink-muted">
          {t('order.net')}:{' '}
          <strong className="text-ink">{net === null ? '—' : formatMoney(net, currency)}</strong>
          <span className="block text-xs text-ink-subtle">{t('order.netHint')}</span>
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('customer.cancel')}
          </Button>
          <Button type="submit" disabled={pending}>
            {t('customer.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
