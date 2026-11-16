import type { CustomerSort } from '@ci/contracts';
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { Button, SelectField, TextField } from '../../components/forms';
import { Card, PageHeader } from '../../components/PageHeader';
import { formatDate, formatMoney, formatNumber } from '../../lib/format';
import { useSession } from '../auth/AuthProvider';
import { CustomerFormDialog } from './CustomerForm';
import { DemoDataButton } from './DemoDataButton';
import { displayName, useCustomerList, type CustomerFilters } from './queries';

const SORTS: CustomerSort[] = [
  '-created_at',
  '-total_spent',
  '-order_count',
  '-last_order_at',
  'name',
];

export function CustomersPage() {
  const { t } = useTranslation();
  const session = useSession();
  const navigate = useNavigate();
  const currency = session.organization.currency;
  const timeZone = session.organization.timezone;
  const canEdit = session.role !== 'VIEWER';
  const canImport = session.role === 'OWNER' || session.role === 'ADMIN';

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<CustomerSort>('-created_at');
  const [hasOrders, setHasOrders] = useState<CustomerFilters['hasOrders']>('');
  const [creating, setCreating] = useState(false);
  const q = useDeferredValue(search.trim());
  const filters = { q, sort, hasOrders };
  const list = useCustomerList(filters);

  const customers = list.data?.pages.flatMap((p) => p.data) ?? [];
  const filtering = Boolean(q || hasOrders);
  const isEmpty = list.isSuccess && customers.length === 0;

  return (
    <>
      <PageHeader
        title={t('customers.title')}
        description={t('customers.description')}
        actions={
          canEdit && (
            <div className="flex gap-2">
              {canImport && (
                <Link
                  to="/imports"
                  className="inline-flex items-center rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-muted"
                >
                  {t('customers.importCta')}
                </Link>
              )}
              <Button onClick={() => setCreating(true)}>{t('customers.new')}</Button>
            </div>
          )
        }
      />

      <Card className="mb-4 p-4">
        <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr]">
          <TextField
            label={t('customers.search')}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <SelectField
            label={t('customers.filterOrders')}
            value={hasOrders}
            onChange={(e) => setHasOrders(e.target.value as CustomerFilters['hasOrders'])}
            options={[
              { value: '', label: t('customers.filterAll') },
              { value: 'true', label: t('customers.filterBuyers') },
              { value: 'false', label: t('customers.filterProspects') },
            ]}
          />
          <SelectField
            label={t('customers.sort')}
            value={sort}
            onChange={(e) => setSort(e.target.value as CustomerSort)}
            options={SORTS.map((value) => ({ value, label: t(`customers.sorts.${value}`) }))}
          />
        </div>
      </Card>

      {isEmpty && !filtering ? (
        <Card className="flex flex-col items-start gap-4">
          <div>
            <h2 className="text-base font-semibold">{t('customers.empty')}</h2>
            <p className="mt-1 text-sm text-ink-muted">{t('customers.emptyHint')}</p>
          </div>
          <div className="flex flex-wrap items-start gap-4">
            {canImport && (
              <Link
                to="/imports"
                className="inline-flex items-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                {t('customers.importCta')}
              </Link>
            )}
            {session.role === 'OWNER' && <DemoDataButton />}
          </div>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line bg-surface-muted text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {t('customers.columns.name')}
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    {t('customers.columns.orders')}
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    {t('customers.columns.spent')}
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {t('customers.columns.lastOrder')}
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                    {t('customers.columns.since')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {customers.map((c) => (
                  <tr
                    key={c.id}
                    className="cursor-pointer hover:bg-surface-muted"
                    onClick={() => navigate(`/customers/${c.id}`)}
                  >
                    <td className="px-4 py-3">
                      <Link
                        to={`/customers/${c.id}`}
                        className="font-medium text-ink hover:text-accent"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {displayName(c, t('customers.unnamed'))}
                      </Link>
                      <div className="text-xs text-ink-subtle">
                        {[c.email, c.externalId].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatNumber(c.stats.orderCount)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatMoney(c.stats.totalNetCents, currency)}
                    </td>
                    <td className="px-4 py-3 text-ink-muted">
                      {formatDate(c.stats.lastOrderAt, undefined, timeZone)}
                    </td>
                    <td className="hidden px-4 py-3 text-ink-muted md:table-cell">
                      {formatDate(
                        c.registeredAt ?? c.createdAt,
                        undefined,
                        c.registeredAt ? 'UTC' : timeZone,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {isEmpty && (
            <p className="px-4 py-6 text-sm text-ink-muted">{t('customers.noMatches')}</p>
          )}
          {list.hasNextPage && (
            <div className="border-t border-line p-3 text-center">
              <Button
                variant="ghost"
                onClick={() => list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {t('customers.loadMore')}
              </Button>
            </div>
          )}
        </Card>
      )}
      <p className="mt-3 text-xs text-ink-subtle">{t('customers.statsNote')}</p>

      {creating && (
        <CustomerFormDialog
          onClose={() => setCreating(false)}
          onSaved={(customer) => navigate(`/customers/${customer.id}`)}
        />
      )}
    </>
  );
}
