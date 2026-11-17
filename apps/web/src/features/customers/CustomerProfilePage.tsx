import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { Alert, Button } from '../../components/forms';
import { Card, PageHeader } from '../../components/PageHeader';
import { ApiError, apiRequest } from '../../lib/api';
import { formatDate, formatDateTime, formatMoney, formatNumber } from '../../lib/format';
import { useSession } from '../auth/AuthProvider';
import { SegmentBadge } from '../segments/SegmentBadge';
import { CustomerFormDialog } from './CustomerForm';
import { InteractionTimeline } from './InteractionTimeline';
import { OrderFormDialog } from './OrderForm';
import { customerKeys, displayName, useCustomer, useCustomerOrders } from './queries';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      <p className="mt-1.5 text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-subtle">{hint}</p>}
    </Card>
  );
}

export function CustomerProfilePage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { currency, timezone } = session.organization;
  const canEdit = session.role !== 'VIEWER';
  const canDelete = session.role === 'OWNER' || session.role === 'ADMIN';

  const customer = useCustomer(id);
  const orders = useCustomerOrders(id);
  const [editing, setEditing] = useState(false);
  const [addingOrder, setAddingOrder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (customer.isError) {
    const notFound = customer.error instanceof ApiError && customer.error.status === 404;
    return (
      <>
        <PageHeader title={notFound ? 'Customer not found' : t('errors.generic')} />
        <Link to="/customers" className="text-sm text-accent hover:underline">
          ← {t('customer.back')}
        </Link>
      </>
    );
  }
  if (!customer.data) return <p className="text-sm text-ink-muted">{t('auth.loading')}</p>;

  const c = customer.data;
  const s = c.stats;
  const orderList = orders.data?.pages.flatMap((p) => p.data) ?? [];

  async function remove() {
    if (!window.confirm(t('customer.deleteConfirm'))) return;
    try {
      await apiRequest('DELETE', `/customers/${id}`);
      await queryClient.invalidateQueries({ queryKey: customerKeys.all });
      navigate('/customers');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('errors.network'));
    }
  }

  const details: [string, string][] = [
    [t('customer.email'), c.email ?? '—'],
    [t('customer.phone'), c.phone ?? '—'],
    [t('customer.externalId'), c.externalId ?? '—'],
    [t('customer.city'), [c.city, c.country].filter(Boolean).join(', ') || '—'],
    [t('customer.registeredAt'), formatDate(c.registeredAt, undefined, 'UTC')],
    [t('customer.marketingConsent'), c.marketingConsent ? t('customer.yes') : t('customer.no')],
    ...(c.segment?.rScore
      ? ([
          [
            t('segments.scores'),
            `R${c.segment.rScore} · F${c.segment.fScore} · M${c.segment.mScore}`,
          ],
        ] as [string, string][])
      : []),
    ...(c.segment
      ? ([
          [
            t('interactions.engagementScore'),
            c.segment.engagementScore === null
              ? t('interactions.engagementNone')
              : `${c.segment.engagementScore} / 100`,
          ],
        ] as [string, string][])
      : []),
  ];

  return (
    <>
      <Link to="/customers" className="mb-3 inline-block text-sm text-accent hover:underline">
        ← {t('customer.back')}
      </Link>
      <PageHeader
        title={displayName(c, t('customers.unnamed'))}
        description={c.tags.length > 0 ? c.tags.map((tag) => `#${tag}`).join('  ') : undefined}
        actions={
          <div className="flex gap-2">
            {canEdit && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                {t('customer.edit')}
              </Button>
            )}
            {canDelete && (
              <Button variant="ghost" onClick={remove}>
                {t('customer.delete')}
              </Button>
            )}
          </div>
        }
      />
      {c.segment && (
        <div className="-mt-3 mb-4">
          <Link to={`/customers?segment=${c.segment.key ?? 'no_purchases'}`}>
            <SegmentBadge segmentKey={c.segment.key} />
          </Link>
        </div>
      )}
      {error && <Alert tone="error">{error}</Alert>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t('customer.orders')} value={formatNumber(s.orderCount)} />
        <Stat label={t('customer.totalSpent')} value={formatMoney(s.totalNetCents, currency)} />
        <Stat
          label={t('customer.aov')}
          value={s.aovCents === null ? '—' : formatMoney(s.aovCents, currency)}
        />
        <Stat
          label={t('customer.lastPurchase')}
          value={formatDate(s.lastOrderAt, undefined, timezone)}
          {...(s.daysSinceLastOrder !== null
            ? {
                hint:
                  s.daysSinceLastOrder === 0
                    ? t('customer.today')
                    : t('customer.daysAgo', { count: s.daysSinceLastOrder }),
              }
            : {})}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_2fr]">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">{t('customer.details')}</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {details.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-ink-muted">{label}</dt>
                <dd className="break-words">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card className="overflow-hidden p-0">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">{t('customer.orders')}</h2>
            {canEdit && (
              <Button
                variant="secondary"
                className="px-3 py-1.5"
                onClick={() => setAddingOrder(true)}
              >
                {t('customer.addOrder')}
              </Button>
            )}
          </div>
          {orderList.length === 0 ? (
            <p className="px-4 py-6 text-sm text-ink-muted">{t('customer.noOrders')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-ink-muted">
                  <tr className="border-b border-line">
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t('order.date')}
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t('order.status')}
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      {t('order.gross')}
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      {t('order.net')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {orderList.map((o) => (
                    <tr key={o.id}>
                      <td className="px-4 py-2">
                        {formatDateTime(o.orderedAt, undefined, timezone)}
                      </td>
                      <td className="px-4 py-2">
                        <span className={o.status === 'completed' ? '' : 'text-ink-muted'}>
                          {t(`order.statuses.${o.status}`)}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatMoney(o.grossCents, currency)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatMoney(o.netCents, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {orders.hasNextPage && (
            <div className="border-t border-line p-2 text-center">
              <Button variant="ghost" onClick={() => orders.fetchNextPage()}>
                {t('customers.loadMore')}
              </Button>
            </div>
          )}
        </Card>
      </div>

      <InteractionTimeline
        customerId={c.id}
        timezone={timezone}
        canEdit={canEdit}
        canDelete={canDelete}
      />

      {editing && <CustomerFormDialog customer={c} onClose={() => setEditing(false)} />}
      {addingOrder && (
        <OrderFormDialog
          customerId={c.id}
          currency={currency}
          onClose={() => setAddingOrder(false)}
        />
      )}
    </>
  );
}
