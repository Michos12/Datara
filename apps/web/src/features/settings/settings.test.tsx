import { DEFAULT_ENGAGEMENT_WEIGHTS, INDUSTRY_PRESETS } from '@ci/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeSession, mockApi, READY, renderApp } from '../../test/fixtures';

describe('SettingsPage', () => {
  it('is read-only for roles that cannot edit', () => {
    mockApi(READY);
    renderApp('/settings', { status: 'authenticated', session: makeSession('VIEWER') });
    expect(
      screen.getByText('Only owners and admins can change these settings.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Business name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('blocks inconsistent thresholds before saving', async () => {
    const fetchMock = mockApi(READY);
    renderApp('/settings', { status: 'authenticated', session: makeSession('OWNER') });
    const churn = screen.getByLabelText('Churn threshold (days)');
    await userEvent.clear(churn);
    await userEvent.type(churn, '20');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('Churn threshold must be longer than the active window'),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/organization'))).toBe(false);
  });

  it('applies the industry preset and saves', async () => {
    const session = makeSession('ADMIN');
    let sent: Record<string, unknown> = {};
    mockApi({
      ...READY,
      'PATCH /organization': (init) => {
        sent = JSON.parse(String(init?.body));
        return {
          status: 200,
          body: { ...session.organization, industry: 'retail', settings: INDUSTRY_PRESETS.retail },
        };
      },
    });
    renderApp('/settings', { status: 'authenticated', session });

    await userEvent.selectOptions(screen.getByLabelText('Industry'), 'retail');
    await userEvent.click(screen.getByRole('button', { name: 'Use Retail store defaults' }));
    expect(screen.getByLabelText('Churn threshold (days)')).toHaveValue(180);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    expect(sent).toMatchObject({ industry: 'retail', settings: INDUSTRY_PRESETS.retail });
  });

  it('saves engagement score weights with the analytics settings', async () => {
    const session = makeSession('OWNER');
    let sent: { settings?: { engagement?: unknown } } = {};
    mockApi({
      ...READY,
      'PATCH /organization': (init) => {
        sent = JSON.parse(String(init?.body));
        return { status: 200, body: { ...session.organization, ...sent } };
      },
    });
    renderApp('/settings', { status: 'authenticated', session });
    const clicked = screen.getByLabelText('Email clicked');
    expect(clicked).toHaveValue(3);
    await userEvent.clear(clicked);
    await userEvent.type(clicked, '6');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    expect(sent.settings?.engagement).toEqual({
      weights: { ...DEFAULT_ENGAGEMENT_WEIGHTS, email_clicked: 6 },
      cap: 10,
    });
  });
});
