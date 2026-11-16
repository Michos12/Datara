import { problemSchema, type Problem } from '@ci/contracts';
import type { z } from 'zod';
import { csrfHeaders, getAccessToken, refreshAccessToken } from './session';

/** Error thrown for non-2xx API responses, carrying the RFC 9457 problem document when present. */
export class ApiError extends Error {
  override name = 'ApiError';

  constructor(
    readonly status: number,
    readonly problem: Problem | null,
  ) {
    super(problem?.detail ?? problem?.title ?? `Request failed with status ${status}`);
  }

  /** Field-level validation messages keyed by path, e.g. { "organization.name": "..." }. */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries((this.problem?.errors ?? []).map((e) => [e.path, e.message]));
  }
}

const BASE = '/api/v1';

export interface RequestOptions<T> {
  body?: unknown;
  schema?: z.ZodType<T>;
  /** Statuses to treat as data rather than errors (e.g. 503 from /ready). */
  acceptStatuses?: number[];
  signal?: AbortSignal;
  /** Send the CSRF header (cookie-authenticated auth endpoints). */
  csrf?: boolean;
}

async function send(method: string, path: string, options: RequestOptions<unknown>) {
  const token = getAccessToken();
  return fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.csrf ? csrfHeaders() : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * Calls the API. An expired access token is refreshed once and the request retried, so
 * callers never handle token expiry themselves. Responses are validated when a schema is given.
 */
export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options: RequestOptions<T> = {},
): Promise<T> {
  let res = await send(method, path, options as RequestOptions<unknown>);
  if (res.status === 401 && getAccessToken()) {
    const refreshed = await refreshAccessToken();
    if (refreshed) res = await send(method, path, options as RequestOptions<unknown>);
  }

  const body: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok && !options.acceptStatuses?.includes(res.status)) {
    const parsed = problemSchema.safeParse(body);
    throw new ApiError(res.status, parsed.success ? parsed.data : null);
  }
  return options.schema ? options.schema.parse(body) : (body as T);
}

export function apiGet<T>(path: string, options: Omit<RequestOptions<T>, 'body'> = {}): Promise<T> {
  return apiRequest('GET', path, options);
}
