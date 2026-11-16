import {
  customerPageSchema,
  customerSchema,
  orderPageSchema,
  type CustomerSort,
} from '@ci/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api';

export interface CustomerFilters {
  q: string;
  sort: CustomerSort;
  hasOrders: '' | 'true' | 'false';
}

export const customerKeys = {
  all: ['customers'] as const,
  list: (filters: CustomerFilters) => ['customers', 'list', filters] as const,
  detail: (id: string) => ['customers', 'detail', id] as const,
  orders: (id: string) => ['customers', 'orders', id] as const,
};

export function useCustomerList(filters: CustomerFilters) {
  return useInfiniteQuery({
    queryKey: customerKeys.list(filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ sort: filters.sort, limit: '50' });
      if (filters.q) params.set('q', filters.q);
      if (filters.hasOrders) params.set('hasOrders', filters.hasOrders);
      if (pageParam) params.set('cursor', pageParam);
      return apiGet(`/customers?${params}`, { schema: customerPageSchema, signal });
    },
    getNextPageParam: (last) => last.page.nextCursor,
  });
}

export function useCustomer(id: string) {
  return useQuery({
    queryKey: customerKeys.detail(id),
    queryFn: ({ signal }) => apiGet(`/customers/${id}`, { schema: customerSchema, signal }),
  });
}

export function useCustomerOrders(id: string) {
  return useInfiniteQuery({
    queryKey: customerKeys.orders(id),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      apiGet(`/customers/${id}/orders?limit=25${pageParam ? `&cursor=${pageParam}` : ''}`, {
        schema: orderPageSchema,
        signal,
      }),
    getNextPageParam: (last) => last.page.nextCursor,
  });
}

export function displayName(
  c: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    externalId: string | null;
  },
  fallback: string,
): string {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
  return name || c.email || c.externalId || fallback;
}
