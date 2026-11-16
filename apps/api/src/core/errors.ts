import { ERROR_CODES, type ErrorCode, type Problem } from '@ci/contracts';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

export interface FieldError {
  path: string;
  message: string;
}

/** A domain error with a stable machine-readable code, mapped to RFC 9457 problem details. */
export class AppError extends Error {
  override name = 'AppError';

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fieldErrors?: FieldError[],
  ) {
    super(message);
  }

  get status(): number {
    return ERROR_CODES[this.code];
  }
}

const TITLES: Record<ErrorCode, string> = {
  BAD_REQUEST: 'Bad request',
  UNAUTHENTICATED: 'Authentication required',
  TOKEN_EXPIRED: 'Access token expired',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflict',
  DUPLICATE_EXTERNAL_ID: 'Duplicate external ID',
  VALIDATION_FAILED: 'Validation failed',
  RATE_LIMITED: 'Too many requests',
  INTERNAL: 'Internal server error',
  ANALYTICS_UNAVAILABLE: 'Analytics service unavailable',
};

export function toProblem(error: AppError, requestId?: string): Problem {
  return {
    type: `/problems/${error.code.toLowerCase().replaceAll('_', '-')}`,
    title: TITLES[error.code],
    status: error.status,
    code: error.code,
    detail: error.message,
    ...(requestId ? { requestId } : {}),
    ...(error.fieldErrors?.length ? { errors: error.fieldErrors } : {}),
  };
}

/** Normalizes anything thrown into an AppError. Unknown errors become a generic 500. */
export function normalizeError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    const fieldErrors = err.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return new AppError(
      'VALIDATION_FAILED',
      `${fieldErrors.length} field(s) are invalid`,
      fieldErrors,
    );
  }
  // body-parser errors (malformed JSON, payload too large) carry an HTTP status and `type`.
  if (isHttpClientError(err)) {
    return new AppError(
      'BAD_REQUEST',
      err.type === 'entity.parse.failed' ? 'Malformed JSON body' : err.message,
    );
  }
  return new AppError('INTERNAL', 'An unexpected error occurred');
}

function isHttpClientError(
  err: unknown,
): err is { status: number; type?: string; message: string } {
  if (typeof err !== 'object' || err === null || !('status' in err)) return false;
  const status = (err as { status: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError('NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appError = normalizeError(err);
  if (appError.status >= 500) {
    req.log.error({ err }, 'request failed');
  } else {
    req.log.info({ code: appError.code }, 'request rejected');
  }
  res
    .status(appError.status)
    .type('application/problem+json')
    .json(toProblem(appError, String(req.id)));
};
