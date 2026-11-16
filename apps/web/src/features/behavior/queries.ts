import {
  churnedCustomersResponseSchema,
  churnResponseSchema,
  cohortsResponseSchema,
  retentionResponseSchema,
  type BehaviorGrain,
} from '@ci/contracts';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api';
import type { Range } from '../overview/periods';

export interface BehaviorFilters {
  range: Range;
  /** Empty: the grain recommended from how often customers buy. */
  grain: BehaviorGrain | '';
  segment: string;
}

function params(filters: BehaviorFilters, extra: Record<string, string> = {}) {
  const search = new URLSearchParams({ start: filters.range.start, end: filters.range.end });
  if (filters.grain) search.set('grain', filters.grain);
  if (filters.segment) search.set('segment', filters.segment);
  for (const [key, value] of Object.entries(extra)) search.set(key, value);
  return search;
}

export function useRetention(filters: BehaviorFilters) {
  return useQuery({
    queryKey: ['analytics', 'retention', filters],
    queryFn: ({ signal }) =>
      apiGet(`/analytics/retention?${params(filters)}`, {
        schema: retentionResponseSchema,
        signal,
      }),
    placeholderData: keepPreviousData,
  });
}

export function useChurn(filters: BehaviorFilters) {
  return useQuery({
    queryKey: ['analytics', 'churn', filters],
    queryFn: ({ signal }) =>
      apiGet(`/analytics/churn?${params(filters)}`, { schema: churnResponseSchema, signal }),
    placeholderData: keepPreviousData,
  });
}

/** Churned customers for a range (no grain), most valuable first. */
export function useChurnedCustomers(range: Range, segment: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['analytics', 'churn-customers', range, segment],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => {
      const search = params({ range, grain: '', segment }, { limit: '25' });
      if (pageParam) search.set('cursor', pageParam);
      return apiGet(`/analytics/churn/customers?${search}`, {
        schema: churnedCustomersResponseSchema,
        signal,
      });
    },
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    enabled,
  });
}

export function useCohorts(range: Range, segment: string, maxPeriods: number) {
  return useQuery({
    queryKey: ['analytics', 'cohorts', range, segment, maxPeriods],
    queryFn: ({ signal }) =>
      apiGet(
        `/analytics/cohorts?${params({ range, grain: '', segment }, { maxPeriods: String(maxPeriods) })}`,
        { schema: cohortsResponseSchema, signal },
      ),
    placeholderData: keepPreviousData,
  });
}
