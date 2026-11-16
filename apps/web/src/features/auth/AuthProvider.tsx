import {
  authResponseSchema,
  sessionSchema,
  type LoginRequest,
  type Organization,
  type Session,
  type SignupRequest,
} from '@ci/contracts';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiGet, apiRequest } from '../../lib/api';
import { onAccessTokenChange, refreshAccessToken, setAccessToken } from '../../lib/session';

export type AuthState =
  { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; session: Session };

interface AuthContextValue {
  state: AuthState;
  login(input: LoginRequest): Promise<void>;
  signup(input: SignupRequest): Promise<void>;
  logout(): Promise<void>;
  /** Replace the cached organization after it was edited. */
  updateOrganization(organization: Organization): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Owns the signed-in session. On load it tries a silent refresh (the httpOnly refresh cookie
 * survives reloads; the access token does not), then loads /auth/me.
 * `initialState` skips that bootstrap, for tests.
 */
export function AuthProvider({
  children,
  initialState,
}: {
  children: ReactNode;
  initialState?: AuthState;
}) {
  const [state, setState] = useState<AuthState>(initialState ?? { status: 'loading' });
  const queryClient = useQueryClient();

  useEffect(() => {
    if (initialState) return;
    let cancelled = false;
    (async () => {
      const token = await refreshAccessToken();
      if (!token) {
        if (!cancelled) setState({ status: 'anonymous' });
        return;
      }
      try {
        const session = await apiGet('/auth/me', { schema: sessionSchema });
        if (!cancelled) setState({ status: 'authenticated', session });
      } catch {
        if (!cancelled) setState({ status: 'anonymous' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialState]);

  // A failed refresh anywhere (e.g. session revoked) signs the user out of the UI.
  useEffect(
    () =>
      onAccessTokenChange((token) => {
        if (token === null) {
          setState((current) =>
            current.status === 'authenticated' ? { status: 'anonymous' } : current,
          );
          queryClient.clear();
        }
      }),
    [queryClient],
  );

  const login = useCallback(async (input: LoginRequest) => {
    const res = await apiRequest('POST', '/auth/login', {
      body: input,
      schema: authResponseSchema,
    });
    setAccessToken(res.accessToken);
    setState({ status: 'authenticated', session: res });
  }, []);

  const signup = useCallback(async (input: SignupRequest) => {
    const res = await apiRequest('POST', '/auth/signup', {
      body: input,
      schema: authResponseSchema,
    });
    setAccessToken(res.accessToken);
    setState({ status: 'authenticated', session: res });
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiRequest('POST', '/auth/logout', { csrf: true });
    } finally {
      setAccessToken(null);
      setState({ status: 'anonymous' });
      queryClient.clear();
    }
  }, [queryClient]);

  const updateOrganization = useCallback((organization: Organization) => {
    setState((current) =>
      current.status === 'authenticated'
        ? { ...current, session: { ...current.session, organization } }
        : current,
    );
  }, []);

  const value = useMemo(
    () => ({ state, login, signup, logout, updateOrganization }),
    [state, login, signup, logout, updateOrganization],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

/** The current session; only valid below <RequireAuth>. */
export function useSession(): Session {
  const { state } = useAuth();
  if (state.status !== 'authenticated') throw new Error('useSession requires a signed-in user');
  return state.session;
}
