import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const checkStatusSchema = z.enum(['up', 'down']);

export const readinessResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({
    database: checkStatusSchema,
    migrations: checkStatusSchema,
    /** Reported but not required for readiness: the API can serve snapshots without it. */
    analytics: checkStatusSchema,
  }),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
