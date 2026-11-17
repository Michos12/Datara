import {
  recommendationCustomersPageSchema,
  recommendationListSchema,
  recommendationSchema,
  type Priority,
  type RecommendationStatus,
  type UpdateRecommendationRequest,
} from '@ci/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiRequest } from '../../lib/api';

export const recommendationKeys = {
  all: ['recommendations'] as const,
  list: (status: RecommendationStatus[], priority: Priority | '', limit: number) =>
    ['recommendations', 'list', status, priority, limit] as const,
  detail: (id: string) => ['recommendations', 'detail', id] as const,
  customers: (id: string) => ['recommendations', 'customers', id] as const,
};

export function useRecommendations(
  status: RecommendationStatus[],
  priority: Priority | '' = '',
  limit = 50,
) {
  return useQuery({
    queryKey: recommendationKeys.list(status, priority, limit),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ status: status.join(','), limit: String(limit) });
      if (priority) params.set('priority', priority);
      return apiGet(`/recommendations?${params}`, { schema: recommendationListSchema, signal });
    },
  });
}

export function useRecommendation(id: string) {
  return useQuery({
    queryKey: recommendationKeys.detail(id),
    queryFn: ({ signal }) =>
      apiGet(`/recommendations/${id}`, { schema: recommendationSchema, signal }),
  });
}

export function useRecommendationCustomers(id: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: recommendationKeys.customers(id),
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      apiGet(
        `/recommendations/${id}/customers?limit=25${pageParam ? `&cursor=${pageParam}` : ''}`,
        {
          schema: recommendationCustomersPageSchema,
          signal,
        },
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    enabled,
  });
}

export function useUpdateRecommendation(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateRecommendationRequest) =>
      apiRequest('PATCH', `/recommendations/${id}`, { body, schema: recommendationSchema }),
    onSuccess: async (updated) => {
      client.setQueryData(recommendationKeys.detail(id), updated);
      await client.invalidateQueries({ queryKey: [...recommendationKeys.all, 'list'] });
    },
  });
}
