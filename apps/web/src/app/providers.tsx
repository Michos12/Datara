import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { AuthProvider, type AuthState } from '../features/auth/AuthProvider';
import { ApiError } from '../lib/api';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        refetchOnWindowFocus: false,
        // Do not retry client errors (4xx): they will not succeed on retry.
        retry: (count, error) =>
          !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      },
    },
  });
}

export function AppProviders({
  children,
  client,
  initialAuth,
}: {
  children: ReactNode;
  /** Tests pass their own client and a pre-resolved auth state. */
  client?: QueryClient;
  initialAuth?: AuthState;
}) {
  const [queryClient] = useState(() => client ?? createQueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider {...(initialAuth ? { initialState: initialAuth } : {})}>
        {children}
      </AuthProvider>
    </QueryClientProvider>
  );
}
