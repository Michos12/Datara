import { AUTH_COOKIES, CSRF_HEADER, refreshResponseSchema } from '@ci/contracts';

/**
 * Access token held in memory only (never localStorage), so an XSS payload cannot read a
 * long-lived credential from storage. The refresh token is an httpOnly cookie the page cannot
 * read at all; the CSRF cookie is readable on purpose (double-submit).
 */
let accessToken: string | null = null;
let inFlight: Promise<string | null> | null = null;
const listeners = new Set<(token: string | null) => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  for (const listener of listeners) listener(token);
}

/** Notified when the token changes; a null token means the session ended. */
export function onAccessTokenChange(listener: (token: string | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readCookie(name: string): string | null {
  const match = document.cookie.split('; ').find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export function csrfHeaders(): Record<string, string> {
  const csrf = readCookie(AUTH_COOKIES.csrf);
  return csrf ? { [CSRF_HEADER]: csrf } : {};
}

/**
 * Exchanges the refresh cookie for a new access token. Concurrent callers share one request,
 * so a burst of expired-token responses triggers a single refresh.
 */
export function refreshAccessToken(): Promise<string | null> {
  inFlight ??= (async () => {
    try {
      if (!readCookie(AUTH_COOKIES.csrf)) {
        setAccessToken(null);
        return null;
      }
      const res = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json', ...csrfHeaders() },
      });
      if (!res.ok) {
        setAccessToken(null);
        return null;
      }
      const body = refreshResponseSchema.parse(await res.json());
      setAccessToken(body.accessToken);
      return body.accessToken;
    } catch {
      setAccessToken(null);
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
