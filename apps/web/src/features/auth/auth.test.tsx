import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { getAccessToken } from '../../lib/session';
import { makeSession, mockApi, READY, renderApp } from '../../test/fixtures';

const anonymous = { status: 'anonymous' as const };

describe('route protection', () => {
  it('sends signed-out users to /login and back after signing in', async () => {
    const session = makeSession();
    mockApi({
      ...READY,
      'POST /auth/login': () => ({
        status: 200,
        body: { ...session, accessToken: 'token-1', expiresIn: 900 },
      }),
    });
    const { router } = renderApp('/settings', anonymous);
    expect(router.state.location.pathname).toBe('/login');

    await userEvent.type(screen.getByLabelText('Email'), 'ana@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings');
    expect(getAccessToken()).toBe('token-1');
  });

  it('keeps signed-in users away from the login page', async () => {
    mockApi(READY);
    const { router } = renderApp('/login', { status: 'authenticated', session: makeSession() });
    await waitFor(() => expect(router.state.location.pathname).toBe('/'), { timeout: 5000 });
  });
});

describe('LoginPage', () => {
  it('shows the server error for bad credentials', async () => {
    mockApi({
      'POST /auth/login': () => ({
        status: 401,
        body: {
          type: '/problems/unauthenticated',
          title: 'Authentication required',
          status: 401,
          code: 'UNAUTHENTICATED',
          detail: 'Invalid email or password',
        },
      }),
    });
    renderApp('/login', anonymous);
    await userEvent.type(screen.getByLabelText('Email'), 'ana@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });
});

describe('SignupPage', () => {
  it('validates on the client before calling the API', async () => {
    const fetchMock = mockApi({});
    renderApp('/signup', anonymous);
    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    expect(await screen.findByText(/at least 12 characters/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates the workspace and opens the app', async () => {
    let sent: Record<string, unknown> = {};
    mockApi({
      ...READY,
      'POST /auth/signup': (init) => {
        sent = JSON.parse(String(init?.body));
        return {
          status: 201,
          body: { ...makeSession(), accessToken: 'token-2', expiresIn: 900 },
        };
      },
    });
    const { router } = renderApp('/signup', anonymous);
    await userEvent.type(screen.getByLabelText('Your name'), 'Ana Pérez');
    await userEvent.type(screen.getByLabelText('Email'), 'ana@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.type(screen.getByLabelText('Business name'), 'Café Central');
    await userEvent.selectOptions(screen.getByLabelText('Industry'), 'restaurant');
    await userEvent.click(screen.getByRole('button', { name: 'Create an account' }));

    await screen.findByText('Café Central · Owner', {}, { timeout: 5000 });
    expect(router.state.location.pathname).toBe('/');
    expect(sent).toMatchObject({
      email: 'ana@example.com',
      organization: { name: 'Café Central', industry: 'restaurant' },
    });
  });
});
