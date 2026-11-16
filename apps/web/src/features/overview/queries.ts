import {
  analyticsStatusSchema,
  definitionsResponseSchema,
  overviewResponseSchema,
  type MetricDefinition,
} from '@ci/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api';
import type { Range } from './periods';

export type Compare = 'previous_period' | 'previous_year' | 'none';

export function useOverview(range: Range, compare: Compare) {
  return useQuery({
    queryKey: ['analytics', 'overview', range, compare],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ start: range.start, end: range.end, compare });
      return apiGet(`/analytics/overview?${params}`, { schema: overviewResponseSchema, signal });
    },
    placeholderData: keepPreviousData,
  });
}

export function useAnalyticsStatus() {
  return useQuery({
    queryKey: ['analytics', 'status'],
    queryFn: ({ signal }) => apiGet('/analytics/status', { schema: analyticsStatusSchema, signal }),
    refetchInterval: (q) =>
      q.state.data?.pending || q.state.data?.latestRun?.status === 'running' ? 5000 : 60_000,
  });
}

export function useDefinitions() {
  return useQuery({
    queryKey: ['analytics', 'definitions'],
    queryFn: ({ signal }) =>
      apiGet('/analytics/definitions', { schema: definitionsResponseSchema, signal }),
    staleTime: 60 * 60_000,
    select: (res) => new Map<string, MetricDefinition>(res.data.map((d) => [d.key, d])),
  });
}
