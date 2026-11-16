import { z } from 'zod';

/** RFC 9457 problem details, the single error shape of the API (docs/04-api-spec.md §1.5). */
export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  requestId: z.string().optional(),
  errors: z
    .array(
      z.object({
        path: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
});

export type Problem = z.infer<typeof problemSchema>;

export const ERROR_CODES = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DUPLICATE_EXTERNAL_ID: 409,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  ANALYTICS_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
