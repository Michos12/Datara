import type { Import } from '@ci/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeSession, mockApi, READY, renderApp } from '../../test/fixtures';

const ID = '0193a2b4-0000-7000-8000-00000000e001';

function imp(overrides: Partial<Import>): Import {
  return {
    id: ID,
    entity: 'customers',
    status: 'uploaded',
    originalName: 'clientes.csv',
    sizeBytes: 120,
    columns: ['Customer ID', 'Nombre', 'Email'],
    mapping: null,
    options: null,
    rowsTotal: 0,
    rowsValid: 0,
    rowsFailed: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    errorSample: [],
    failureReason: null,
    createdAt: '2026-11-16T00:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

describe('ImportsPage', () => {
  it('walks through upload, mapping, review and import', async () => {
    let state = imp({});
    let sentMapping: unknown;
    mockApi({
      ...READY,
      'GET /imports': () => ({ status: 200, body: { data: [] } }),
      'POST /imports': () => ({
        status: 201,
        body: {
          import: state,
          sampleRows: [{ 'Customer ID': 'C-1', Nombre: 'Ana', Email: 'ana@example.com' }],
          suggestedMapping: { externalId: 'Customer ID', firstName: 'Nombre', email: null },
        },
      }),
      [`PUT /imports/${ID}/mapping`]: (init) => {
        sentMapping = JSON.parse(String(init?.body));
        state = imp({
          status: 'validated',
          rowsTotal: 2,
          rowsValid: 1,
          rowsFailed: 1,
          errorSample: [{ line: 3, field: 'email', message: 'Invalid email address' }],
        });
        return { status: 202, body: { ...state, status: 'validating' } };
      },
      [`GET /imports/${ID}`]: () => ({ status: 200, body: state }),
      [`POST /imports/${ID}/commit`]: () => {
        state = imp({ ...state, status: 'completed', rowsInserted: 1 });
        return { status: 202, body: { ...state, status: 'importing' } };
      },
    });
    renderApp('/imports', { status: 'authenticated', session: makeSession('ADMIN') });

    const file = new File(['Customer ID,Nombre,Email\nC-1,Ana,ana@example.com\n'], 'clientes.csv', {
      type: 'text/csv',
    });
    await userEvent.upload(await screen.findByLabelText('CSV file'), file);
    await userEvent.click(screen.getByRole('button', { name: 'Upload and continue' }));

    // Mapping step: suggested mapping preselected; complete it manually.
    expect(await screen.findByText('Match your columns')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Customer ID · Required/)).toHaveValue('Customer ID');
    await userEvent.selectOptions(screen.getByLabelText(/^Email/), 'Email');
    expect(screen.getByText('ana@example.com')).toBeInTheDocument(); // preview
    await userEvent.click(screen.getByRole('button', { name: 'Check file' }));

    expect(
      await screen.findByText('1 of 2 rows are ready to import.', {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Invalid email address')).toBeInTheDocument();
    expect(sentMapping).toMatchObject({ mapping: { externalId: 'Customer ID', email: 'Email' } });

    await userEvent.click(screen.getByRole('button', { name: 'Import 1 rows' }));
    expect(
      await screen.findByText(
        /Import finished: 1 added, 0 updated, 1 skipped/,
        {},
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
  });

  it('is limited to owners and admins', () => {
    mockApi({ ...READY, 'GET /imports': () => ({ status: 200, body: { data: [] } }) });
    renderApp('/imports', { status: 'authenticated', session: makeSession('ANALYST') });
    expect(
      screen.getByText('Only owners and admins can change these settings.'),
    ).toBeInTheDocument();
  });
});
