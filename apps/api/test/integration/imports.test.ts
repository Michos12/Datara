import { importSchema, importUploadResponseSchema } from '@ci/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, createTestContext, signup, type TestSession } from './harness.js';

const ctx = createTestContext();
let session: TestSession;
let api: ReturnType<typeof authed>;

beforeAll(async () => {
  session = await signup(ctx.app, {
    organization: {
      name: 'Importer',
      timezone: 'America/Bogota',
      currency: 'USD',
      industry: 'ecommerce',
    },
  });
  api = authed(ctx.app, session.accessToken);
});
afterAll(() => ctx.close());

// Semicolon-delimited, BOM, CRLF, quoted values, a bad row and a duplicate ID.
const CUSTOMERS_CSV =
  '﻿Customer ID;Nombre;Apellido;Email;País;Tags;Newsletter\r\n' +
  'C-1;Ana;Pérez;ana@example.com;CO;vip|new;yes\r\n' +
  'C-2;"Luis; Jr.";Gómez;luis@example.com;co;;no\r\n' +
  'C-3;Bad;Row;not-an-email;Colombia;;maybe\r\n' +
  'C-1;Ana;Duplicate;ana2@example.com;CO;;yes\r\n';

const CUSTOMER_MAPPING = {
  externalId: 'Customer ID',
  firstName: 'Nombre',
  lastName: 'Apellido',
  email: 'Email',
  country: 'País',
  tags: 'Tags',
  marketingConsent: 'Newsletter',
};

async function runImport(
  entity: 'customers' | 'orders',
  csv: string,
  mapping: object,
  options = {},
) {
  const upload = await api.upload(entity, csv);
  expect(upload.status).toBe(201);
  const { import: created } = importUploadResponseSchema.parse(upload.body);
  const mapped = await api.put(`/imports/${created.id}/mapping`, { mapping, options });
  expect(mapped.status).toBe(202);
  await ctx.runJobs();
  return importSchema.parse((await api.get(`/imports/${created.id}`)).body);
}

async function commit(id: string) {
  expect((await api.post(`/imports/${id}/commit`)).status).toBe(202);
  await ctx.runJobs();
  return importSchema.parse((await api.get(`/imports/${id}`)).body);
}

describe('customer import', () => {
  it('detects columns, suggests a mapping and shows sample rows', async () => {
    const res = await api.upload('customers', CUSTOMERS_CSV, 'clientes.csv');
    const body = importUploadResponseSchema.parse(res.body);
    expect(body.import.columns).toEqual([
      'Customer ID',
      'Nombre',
      'Apellido',
      'Email',
      'País',
      'Tags',
      'Newsletter',
    ]);
    expect(body.suggestedMapping).toMatchObject({
      externalId: 'Customer ID',
      firstName: 'Nombre',
      lastName: 'Apellido',
      email: 'Email',
      country: 'País',
      tags: 'Tags',
      marketingConsent: 'Newsletter',
    });
    expect(body.sampleRows[1]).toMatchObject({ Nombre: 'Luis; Jr.' });
    expect(body.import.status).toBe('uploaded');
  });

  it('validates every row, reports errors by line, then imports only valid rows', async () => {
    const validated = await runImport('customers', CUSTOMERS_CSV, CUSTOMER_MAPPING);
    expect(validated).toMatchObject({
      status: 'validated',
      rowsTotal: 4,
      rowsValid: 2,
      rowsFailed: 2,
    });
    expect(validated.errorSample).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 4, field: 'email' }),
        expect.objectContaining({ line: 4, field: 'country' }),
        expect.objectContaining({ line: 4, field: 'marketingConsent' }),
        expect.objectContaining({ line: 5, field: 'externalId' }),
      ]),
    );

    const report = await api.get(`/imports/${validated.id}/errors.csv`);
    expect(report.status).toBe(200);
    expect(report.headers['content-type']).toMatch(/text\/csv/);
    expect(report.text).toContain('line,field,message');
    expect(report.text).toMatch(/4,email,/);

    const done = await commit(validated.id);
    expect(done).toMatchObject({ status: 'completed', rowsInserted: 2, rowsUpdated: 0 });

    const list = await api.get('/customers?q=example.com&sort=name');
    expect(list.body.data.map((c: { externalId: string }) => c.externalId).sort()).toEqual([
      'C-1',
      'C-2',
    ]);
    const ana = list.body.data.find((c: { externalId: string }) => c.externalId === 'C-1');
    expect(ana).toMatchObject({
      firstName: 'Ana',
      country: 'CO',
      tags: ['vip', 'new'],
      marketingConsent: true,
    });

    const audit = await api.get('/organization/audit-logs?limit=5');
    expect(audit.body.data.map((e: { action: string }) => e.action)).toContain('import.commit');
  });

  it('is idempotent: re-importing updates instead of duplicating, and keeps unmapped fields', async () => {
    const again = await runImport('customers', 'id,first name\nC-1,Ana María\nC-2,Luis\n', {
      externalId: 'id',
      firstName: 'first name',
    });
    const done = await commit(again.id);
    expect(done).toMatchObject({ rowsInserted: 0, rowsUpdated: 2 });

    const list = await api.get('/customers?q=C-1');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ firstName: 'Ana María', email: 'ana@example.com' });
  });

  it('requires the mandatory fields to be mapped', async () => {
    const upload = await api.upload('customers', 'name\nAna\n');
    const res = await api.put(`/imports/${upload.body.import.id}/mapping`, {
      mapping: { firstName: 'name' },
    });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].path).toBe('mapping.externalId');
  });

  it('refuses to commit before validation', async () => {
    const upload = await api.upload('customers', 'id\nX-1\n');
    const res = await api.post(`/imports/${upload.body.import.id}/commit`);
    expect(res.status).toBe(409);
  });
});

describe('order import', () => {
  it('links customers, supports guests, and reads dates in the organization time zone', async () => {
    const csv =
      'order_id,customer_id,date,total,discount,refund,status\n' +
      'O-1,C-1,2026-10-05 21:30,"1,250.00",50.00,0,paid\n' +
      'O-2,,05/10/2026,20.00,,,\n' +
      'O-3,C-404,2026-10-06,10.00,,,completed\n' +
      'O-4,C-2,2026-10-07,10.00,,20.00,completed\n';
    const validated = await runImport(
      'orders',
      csv,
      {
        externalId: 'order_id',
        customerExternalId: 'customer_id',
        orderedAt: 'date',
        grossAmount: 'total',
        discountAmount: 'discount',
        refundedAmount: 'refund',
        status: 'status',
      },
      { dateFormat: 'DMY' },
    );
    expect(validated).toMatchObject({ rowsValid: 2, rowsFailed: 2 });
    expect(validated.errorSample).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 4, field: 'customerExternalId' }),
        expect.objectContaining({ line: 5, field: 'refundedAmount' }),
      ]),
    );

    await commit(validated.id);
    const orders = await api.get('/orders?limit=10');
    const byId = Object.fromEntries(
      orders.body.data.map((o: { externalId: string }) => [o.externalId, o]),
    );
    expect(byId['O-1']).toMatchObject({
      orderedAt: '2026-10-06T02:30:00.000Z', // 21:30 in Bogotá (UTC-5)
      grossCents: 125000,
      discountCents: 5000,
      netCents: 120000,
      status: 'completed',
    });
    expect(byId['O-2']).toMatchObject({ customerId: null, orderedAt: '2026-10-05T05:00:00.000Z' });

    const customer = (await api.get('/customers?q=C-1')).body.data[0];
    expect(customer.stats).toMatchObject({ orderCount: 1, totalNetCents: 120000 });
  });
});

describe('upload checks', () => {
  it('rejects non-CSV bodies and files without data rows', async () => {
    const wrongType = await api.post('/imports?entity=customers', { a: 1 });
    expect(wrongType.status).toBe(400);
    expect((await api.upload('customers', 'id,name\n')).status).toBe(422);
    expect((await api.upload('customers', '')).status).toBe(422);
  });

  it('serves CSV templates', async () => {
    const res = await api.get('/imports/templates/orders.csv');
    expect(res.status).toBe(200);
    expect(res.text).toContain('externalId,customerExternalId,orderedAt,grossAmount');
  });
});

describe('demo data', () => {
  it('only seeds organizations without data', async () => {
    const res = await api.post('/organization/demo-data', { size: 'small' });
    expect(res.status).toBe(409);

    const fresh = await signup(ctx.app);
    const queued = await authed(ctx.app, fresh.accessToken).post('/organization/demo-data', {
      size: 'small',
    });
    expect(queued.status).toBe(202);
    const job = await authed(ctx.app, fresh.accessToken).get(`/jobs/${queued.body.jobId}`);
    expect(job.body).toMatchObject({ type: 'analytics.demo_data', status: 'pending' });
    // Another organization cannot see this job.
    expect((await api.get(`/jobs/${queued.body.jobId}`)).status).toBe(404);
  });
});
