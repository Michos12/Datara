import {
  segmentConfigVersionSchema,
  segmentsResponseSchema,
  type SegmentConfigVersion,
} from '@ci/contracts';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api';

export function useSegments() {
  return useQuery({
    queryKey: ['segments', 'summary'],
    queryFn: ({ signal }) => apiGet('/segments', { schema: segmentsResponseSchema, signal }),
  });
}

export function useSegmentConfig() {
  return useQuery({
    queryKey: ['segments', 'config'],
    queryFn: ({ signal }) =>
      apiGet('/segments/config', { schema: segmentConfigVersionSchema, signal }),
    staleTime: 5 * 60_000,
  });
}

/** key → { name, color } for badges and filters. */
export function segmentLookup(config: SegmentConfigVersion | undefined) {
  return new Map(
    (config?.config.rules ?? []).map((r) => [r.key, { name: r.name, color: r.color }]),
  );
}
