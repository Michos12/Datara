import { describe, expect, it } from 'vitest';
import { mockApi } from '../test/fixtures';
import { ApiError, apiGet } from './api';
import { getAccessToken, refreshAccessToken, setAccessToken } from './session';

const expired = {
  status: 401,
  body: {
    type: '/problems/token-expired',
    title: 'Access token expired',
    status: 401,
    code: 'TOKEN_EXPIRED',
  },
};

describe('apiRequest token refresh', () => {
  it('refreshes an expired access token once and retries', async () => {
    document.cookie = 'ci_csrf=csrf-1; path=/';
    setAccessToken('old');
    const seen: string[] = [];
    const fetchMock = mockApi({
      'GET /organization': (init) => {
        const auth = new Headers(init?.headers).get('Authorization');
        seen.push(auth ?? '');
        return auth === 'Bearer new' ? { status: 200, body: { ok: true } } : expired;
      },
      'POST /auth/refresh': (init) => {
        expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf-1');
        return { status: 200, body: { accessToken: 'new', expiresIn: 900 } };
      },
    });

    await expect(apiGet('/organization')).resolves.toEqual({ ok: true });
    expect(seen).toEqual(['Bearer old', 'Bearer new']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('ends the session when the refresh fails', async () => {
    document.cookie = 'ci_csrf=csrf-1; path=/';
    setAccessToken('old');
    mockApi({
      'GET /organization': () => expired,
      'POST /auth/refresh': () => ({ status: 401, body: { code: 'UNAUTHENTICATED' } }),
    });
    await expect(apiGet('/organization')).rejects.toBeInstanceOf(ApiError);
    expect(getAccessToken()).toBeNull();
  });

  it('shares one refresh between concurrent callers', async () => {
    document.cookie = 'ci_csrf=csrf-1; path=/';
    const fetchMock = mockApi({
      'POST /auth/refresh': () => ({ status: 200, body: { accessToken: 't', expiresIn: 900 } }),
    });
    await Promise.all([refreshAccessToken(), refreshAccessToken(), refreshAccessToken()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not call refresh without a CSRF cookie (never signed in)', async () => {
    const fetchMock = mockApi({});
    expect(await refreshAccessToken()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
