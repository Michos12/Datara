import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { makeSession, mockApi, READY, renderApp } from '../../test/fixtures';

const anonymous = { status: 'anonymous' as const };
const members = {
  data: [
    {
      userId: '0193a2b4-0000-7000-8000-0000000000aa',
      email: 'ana@example.com',
      fullName: 'Ana Pérez',
      role: 'OWNER',
      joinedAt: '2026-11-01T00:00:00.000Z',
      lastLoginAt: '2026-11-16T00:00:00.000Z',
    },
    {
      userId: '0193a2b4-0000-7000-8000-0000000000bb',
      email: 'ben@example.com',
      fullName: 'Ben Ortiz',
      role: 'ANALYST',
      joinedAt: '2026-11-02T00:00:00.000Z',
      lastLoginAt: null,
    },
  ],
};
const body = (init: RequestInit | undefined) => JSON.parse(String(init?.body));

afterEach(() => window.history.replaceState(null, '', '/'));

describe('Team page', () => {
  it('lists members and sends invitations', async () => {
    let sent: unknown = null;
    mockApi({
      ...READY,
      'GET /organization/members': () => ({ status: 200, body: members }),
      'GET /organization/invitations': () => ({ status: 200, body: { data: [] } }),
      'POST /organization/invitations': (init) => {
        sent = body(init);
        return {
          status: 201,
          body: {
            id: '0193a2b4-0000-7000-8000-0000000000cc',
            email: 'cleo@example.com',
            role: 'VIEWER',
            invitedBy: 'Ana Pérez',
            expiresAt: '2026-11-24T00:00:00.000Z',
            createdAt: '2026-11-17T00:00:00.000Z',
            emailSent: true,
          },
        };
      },
    });
    renderApp('/team', { status: 'authenticated', session: makeSession('OWNER') });
    const table = await screen.findByRole('table', { name: 'Members' });
    expect(await within(table).findByText('Ben Ortiz')).toBeInTheDocument();
    expect(within(table).getByText('Never')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Email'), 'cleo@example.com');
    await userEvent.selectOptions(screen.getByLabelText(/^Role$/), 'VIEWER');
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Invitation sent to cleo@example.com.')).toBeInTheDocument();
    expect(sent).toEqual({ email: 'cleo@example.com', role: 'VIEWER' });
  });

  it('does not let admins create or edit owners', async () => {
    mockApi({
      ...READY,
      'GET /organization/members': () => ({ status: 200, body: members }),
      'GET /organization/invitations': () => ({ status: 200, body: { data: [] } }),
    });
    renderApp('/team', { status: 'authenticated', session: makeSession('ADMIN') });
    const ownerRole = await screen.findByLabelText('Role: Ana Pérez');
    expect(ownerRole).toBeDisabled();
    const inviteRole = screen.getByLabelText(/^Role$/);
    expect(within(inviteRole).queryByRole('option', { name: 'Owner' })).not.toBeInTheDocument();
  });

  it('is read-only for analysts', () => {
    mockApi(READY);
    renderApp('/team', { status: 'authenticated', session: makeSession('ANALYST') });
    expect(screen.getByText('Only owners and admins can manage the team.')).toBeInTheDocument();
  });
});

describe('password reset pages', () => {
  it('confirms a reset request without revealing whether the account exists', async () => {
    mockApi({
      ...READY,
      'POST /auth/password/forgot': () => ({ status: 202, body: { status: 'accepted' } }),
    });
    renderApp('/forgot-password', anonymous);
    await userEvent.type(screen.getByLabelText('Email'), 'ana@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/If an account exists for ana@example.com/)).toBeInTheDocument();
  });

  it('reads the token from the link fragment and sets the new password', async () => {
    let sent: unknown = null;
    mockApi({
      ...READY,
      'POST /auth/password/reset': (init) => {
        sent = body(init);
        return { status: 204 };
      },
    });
    window.history.replaceState(null, '', '/reset-password#token=abcdefghijklmnopqrstuvwxyz');
    renderApp('/reset-password', anonymous);
    await userEvent.type(screen.getByLabelText('New password'), 'a long enough passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText(/Your password was changed/)).toBeInTheDocument();
    expect(sent).toEqual({
      token: 'abcdefghijklmnopqrstuvwxyz',
      newPassword: 'a long enough passphrase',
    });
  });

  it('explains a link without a token', () => {
    mockApi(READY);
    renderApp('/reset-password', anonymous);
    expect(screen.getByText(/This link is incomplete/)).toBeInTheDocument();
  });
});

describe('invitation page', () => {
  it('lets a new person create an account and join', async () => {
    let sent: unknown = null;
    const session = makeSession('ANALYST');
    mockApi({
      ...READY,
      'POST /invitations/preview': () => ({
        status: 200,
        body: {
          organizationName: 'Café Central',
          email: 'new@example.com',
          role: 'ANALYST',
          accountExists: false,
          expiresAt: '2026-11-24T00:00:00.000Z',
        },
      }),
      'POST /invitations/accept': (init) => {
        sent = body(init);
        return { status: 200, body: { ...session, accessToken: 'token', expiresIn: 900 } };
      },
      'GET /analytics/overview': () => ({ status: 503 }),
    });
    window.history.replaceState(null, '', '/invitation#token=abcdefghijklmnopqrstuvwxyz');
    renderApp('/invitation', anonymous);
    expect(await screen.findByRole('heading', { name: 'Join Café Central' })).toBeInTheDocument();
    expect(
      screen.getByText('You were invited as Analyst with new@example.com.'),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Your name'), 'Nia New');
    await userEvent.type(screen.getByLabelText('Password'), 'a long enough passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Join organization' }));
    await waitFor(() =>
      expect(sent).toEqual({
        token: 'abcdefghijklmnopqrstuvwxyz',
        password: 'a long enough passphrase',
        fullName: 'Nia New',
      }),
    );
  });

  it('shows why an invitation cannot be used', async () => {
    mockApi({
      ...READY,
      'POST /invitations/preview': () => ({
        status: 400,
        body: {
          type: '/problems/bad-request',
          title: 'Bad request',
          status: 400,
          code: 'BAD_REQUEST',
          detail: 'This invitation is invalid, used or expired',
        },
      }),
    });
    window.history.replaceState(null, '', '/invitation#token=abcdefghijklmnopqrstuvwxyz');
    renderApp('/invitation', anonymous);
    expect(
      await screen.findByText('This invitation is invalid, used or expired'),
    ).toBeInTheDocument();
  });
});

describe('organization switcher', () => {
  it('switches the active organization', async () => {
    const session = makeSession('OWNER');
    const multi = {
      ...session,
      memberships: [
        ...session.memberships,
        {
          organizationId: '0193a2b4-0000-7000-8000-000000000002',
          organizationName: 'Second Shop',
          role: 'VIEWER' as const,
        },
      ],
    };
    let sent: unknown = null;
    mockApi({
      ...READY,
      'GET /organization/members': () => ({ status: 200, body: members }),
      'GET /organization/invitations': () => ({ status: 200, body: { data: [] } }),
      'POST /auth/switch-organization': (init) => {
        sent = body(init);
        return {
          status: 200,
          body: {
            ...multi,
            role: 'VIEWER',
            organization: {
              ...session.organization,
              id: '0193a2b4-0000-7000-8000-000000000002',
              name: 'Second Shop',
            },
            accessToken: 'token',
            expiresIn: 900,
          },
        };
      },
    });
    renderApp('/team', { status: 'authenticated', session: multi });
    await userEvent.selectOptions(screen.getByLabelText('Switch organization'), 'Second Shop');
    expect(await screen.findByText('Second Shop · Viewer')).toBeInTheDocument();
    expect(sent).toEqual({ organizationId: '0193a2b4-0000-7000-8000-000000000002' });
  });
});
