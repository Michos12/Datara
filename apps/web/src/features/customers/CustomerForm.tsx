import {
  createCustomerRequestSchema,
  customerSchema,
  updateCustomerRequestSchema,
  type Customer,
} from '@ci/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, issuesToFieldErrors, TextField } from '../../components/forms';
import { Modal } from '../../components/Modal';
import { ApiError, apiRequest } from '../../lib/api';
import { customerKeys } from './queries';

type Draft = Record<
  | 'externalId'
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'phone'
  | 'country'
  | 'city'
  | 'registeredAt'
  | 'tags',
  string
> & { marketingConsent: boolean };

function toDraft(c?: Customer): Draft {
  return {
    externalId: c?.externalId ?? '',
    firstName: c?.firstName ?? '',
    lastName: c?.lastName ?? '',
    email: c?.email ?? '',
    phone: c?.phone ?? '',
    country: c?.country ?? '',
    city: c?.city ?? '',
    registeredAt: c?.registeredAt ?? '',
    tags: c?.tags.join(', ') ?? '',
    marketingConsent: c?.marketingConsent ?? false,
  };
}

function toBody(d: Draft) {
  const text = (v: string) => (v.trim() === '' ? null : v.trim());
  return {
    externalId: text(d.externalId),
    firstName: text(d.firstName),
    lastName: text(d.lastName),
    email: text(d.email),
    phone: text(d.phone),
    country: text(d.country),
    city: text(d.city),
    registeredAt: text(d.registeredAt),
    tags: d.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    marketingConsent: d.marketingConsent,
  };
}

/** Create (no `customer`) or edit a customer. */
export function CustomerFormDialog({
  customer,
  onClose,
  onSaved,
}: {
  customer?: Customer;
  onClose: () => void;
  onSaved?: (customer: Customer) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => toDraft(customer));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => ({
      ...d,
      [key]: key === 'marketingConsent' ? e.target.checked : e.target.value,
    }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const body = toBody(draft);
    const schema = customer ? updateCustomerRequestSchema : createCustomerRequestSchema;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    setPending(true);
    try {
      const saved = await apiRequest(
        customer ? 'PATCH' : 'POST',
        customer ? `/customers/${customer.id}` : '/customers',
        {
          body: parsed.data,
          schema: customerSchema,
        },
      );
      await queryClient.invalidateQueries({ queryKey: customerKeys.all });
      onSaved?.(saved);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setError(err.message);
      } else setError(t('errors.network'));
      setPending(false);
    }
  }

  const field = (key: Exclude<keyof Draft, 'marketingConsent'>, extra: object = {}) => (
    <TextField
      label={t(`customer.${key}`)}
      value={draft[key]}
      onChange={set(key)}
      error={fieldErrors[key]}
      {...extra}
    />
  );

  return (
    <Modal title={customer ? t('customer.edit') : t('customers.new')} onClose={onClose}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          {field('firstName', { autoComplete: 'off' })}
          {field('lastName', { autoComplete: 'off' })}
          {field('email', { type: 'email', autoComplete: 'off' })}
          {field('phone', { type: 'tel', autoComplete: 'off' })}
          {field('externalId')}
          {field('registeredAt', { type: 'date' })}
          {field('country', { maxLength: 2, placeholder: 'CO' })}
          {field('city')}
        </div>
        {field('tags', { hint: t('customer.tagsHint') })}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.marketingConsent}
            onChange={set('marketingConsent')}
          />
          {t('customer.marketingConsent')}
        </label>
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
