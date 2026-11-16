import { readinessResponseSchema, type ReadinessResponse } from '@ci/contracts';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api';

/** Polls API readiness. 503 is a valid answer ("not ready"), not a request failure. */
export function useReadiness() {
  return useQuery<ReadinessResponse>({
    queryKey: ['system', 'ready'],
    queryFn: ({ signal }) =>
      apiGet('/ready', { schema: readinessResponseSchema, acceptStatuses: [503], signal }),
    refetchInterval: 30_000,
    retry: false,
  });
}
