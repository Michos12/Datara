import {
  clvResponseSchema,
  engagementResponseSchema,
  frequencyResponseSchema,
  journeyResponseSchema,
} from '@ci/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { apiGet } from '../../lib/api';
import type { Range } from '../overview/periods';

export interface ValueFilters {
  range: Range;
  segment: string;
}

function useValue<T>(
  kind: 'frequency' | 'clv' | 'journey' | 'engagement',
  schema: z.ZodType<T>,
  filters: ValueFilters,
) {
  return useQuery({
    queryKey: ['analytics', kind, filters],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ start: filters.range.start, end: filters.range.end });
      if (filters.segment) params.set('segment', filters.segment);
      return apiGet(`/analytics/${kind}?${params}`, { schema, signal });
    },
    placeholderData: keepPreviousData,
  });
}

export const useFrequency = (filters: ValueFilters) =>
  useValue('frequency', frequencyResponseSchema, filters);
export const useClv = (filters: ValueFilters) => useValue('clv', clvResponseSchema, filters);
export const useJourney = (filters: ValueFilters) =>
  useValue('journey', journeyResponseSchema, filters);
export const useEngagement = (filters: ValueFilters) =>
  useValue('engagement', engagementResponseSchema, filters);
