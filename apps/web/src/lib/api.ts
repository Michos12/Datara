import { problemSchema, type Problem } from '@ci/contracts';
import type { z } from 'zod';

/** Error thrown for non-2xx API responses, carrying the RFC 9457 problem document when present. */
export class ApiError extends Error {
  override name = 'ApiError';

  constructor(
    readonly status: number,
    readonly problem: Problem | null,
  ) {
    super(problem?.detail ?? problem?.title ?? `Request failed with status ${status}`);
  }
}

const BASE = '/api/v1';

/**
 * GET a JSON resource. When `schema` is given the body is validated, so a contract drift
 * surfaces as a clear error instead of undefined values deep in a component.
 * `acceptStatuses` lets callers treat e.g. 503 from /ready as data rather than an error.
 */
export async function apiGet<T>(
  path: string,
  options: { schema?: z.ZodType<T>; acceptStatuses?: number[]; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: 'application/json' },
    credentials: 'include',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const body: unknown = await res.json().catch(() => null);

  if (!res.ok && !options.acceptStatuses?.includes(res.status)) {
    const parsed = problemSchema.safeParse(body);
    throw new ApiError(res.status, parsed.success ? parsed.data : null);
  }
  return options.schema ? options.schema.parse(body) : (body as T);
}
