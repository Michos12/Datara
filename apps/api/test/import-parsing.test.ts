import { suggestMapping } from '@ci/contracts';
import { describe, expect, it } from 'vitest';
import {
  CellError,
  detectDelimiter,
  parseAmount,
  parseBoolean,
  parseCustomerRow,
  parseDateOnly,
  parseDateTime,
  parseOrderRow,
  parseOrderStatus,
  parseTags,
  zonedTimeToUtc,
  type ParseContext,
} from '../src/modules/imports/parsing.js';

const usd = { decimalSeparator: '.' as const, currency: 'USD', inMinorUnits: false };

describe('parseAmount', () => {
  it.each([
    ['12', 1200],
    ['12.5', 1250],
    ['12.50', 1250],
    ['1,234.56', 123456],
    ['$ 1,234.56', 123456],
    ['USD 99.99', 9999],
    ['0', 0],
    ['+7.00', 700],
  ])('reads %s as %d cents', (raw, cents) => {
    expect(parseAmount(raw, usd)).toBe(cents);
  });

  it('supports decimal commas and dot thousands separators', () => {
    expect(parseAmount('1.234,56 €', { ...usd, decimalSeparator: ',', currency: 'EUR' })).toBe(
      123456,
    );
    expect(parseAmount("12'000,5", { ...usd, decimalSeparator: ',' })).toBe(1200050);
  });

  it('respects currencies without or with three minor digits', () => {
    expect(parseAmount('12.000', { ...usd, currency: 'COP', decimalSeparator: ',' })).toBe(1200000);
    expect(parseAmount('1500', { ...usd, currency: 'JPY' })).toBe(1500);
    expect(() => parseAmount('15.5', { ...usd, currency: 'JPY' })).toThrow(CellError);
    expect(parseAmount('1.234', { ...usd, currency: 'KWD' })).toBe(1234);
  });

  it('accepts amounts already in minor units', () => {
    expect(parseAmount('1250', { ...usd, inMinorUnits: true })).toBe(1250);
    expect(() => parseAmount('12.50', { ...usd, inMinorUnits: true })).toThrow(/whole minor units/);
  });

  it.each(['-5', '(5.00)', 'abc', '1.2.3', '12.345'])('rejects %s', (raw) => {
    expect(() => parseAmount(raw, usd)).toThrow(CellError);
  });

  it('never loses precision on large values', () => {
    expect(parseAmount('90071992547409.91', usd)).toBe(9007199254740991);
    expect(() => parseAmount('90071992547409.92', usd)).toThrow(/too large/);
  });
});

describe('dates and time zones', () => {
  const bogota = { dateFormat: 'auto' as const, timeZone: 'America/Bogota' };

  it('reads wall-clock times in the organization time zone', () => {
    expect(parseDateTime('2026-03-31 23:30', bogota).toISOString()).toBe(
      '2026-04-01T04:30:00.000Z',
    );
    expect(parseDateTime('2026-03-31', bogota).toISOString()).toBe('2026-03-31T05:00:00.000Z');
  });

  it('keeps explicit offsets', () => {
    expect(parseDateTime('2026-03-31T23:30:00Z', bogota).toISOString()).toBe(
      '2026-03-31T23:30:00.000Z',
    );
    expect(parseDateTime('2026-03-31T23:30:00+02:00', bogota).toISOString()).toBe(
      '2026-03-31T21:30:00.000Z',
    );
  });

  it('handles daylight-saving transitions', () => {
    // New York springs forward on 2026-03-08 at 02:00 → 03:00 (UTC-5 → UTC-4).
    expect(
      zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 1 }, 'America/New_York').toISOString(),
    ).toBe('2026-03-08T06:00:00.000Z');
    expect(
      zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 4 }, 'America/New_York').toISOString(),
    ).toBe('2026-03-08T08:00:00.000Z');
    // Madrid in summer is UTC+2.
    expect(zonedTimeToUtc({ year: 2026, month: 7, day: 1 }, 'Europe/Madrid').toISOString()).toBe(
      '2026-06-30T22:00:00.000Z',
    );
  });

  it('resolves day/month order automatically only when unambiguous', () => {
    expect(parseDateOnly('31/03/2026', bogota)).toBe('2026-03-31');
    expect(parseDateOnly('03/31/2026', bogota)).toBe('2026-03-31');
    expect(() => parseDateOnly('03/04/2026', bogota)).toThrow(/ambiguous/);
    expect(parseDateOnly('03/04/2026', { ...bogota, dateFormat: 'DMY' })).toBe('2026-04-03');
    expect(parseDateOnly('03/04/2026', { ...bogota, dateFormat: 'MDY' })).toBe('2026-03-04');
    expect(parseDateOnly('2026/04/03', bogota)).toBe('2026-04-03');
    expect(parseDateOnly('3.4.26', { ...bogota, dateFormat: 'DMY' })).toBe('2026-04-03');
  });

  it.each(['31/02/2026', '2026-13-01', 'yesterday', '2026-01-01 25:00'])('rejects %s', (raw) => {
    expect(() => parseDateOnly(raw, { ...bogota, dateFormat: 'DMY' })).toThrow(CellError);
  });

  it('converts a timestamp to the local calendar date', () => {
    expect(parseDateOnly('2026-04-01T02:00:00Z', bogota)).toBe('2026-03-31');
  });
});

describe('other cells', () => {
  it('parses booleans in English and Spanish', () => {
    expect(parseBoolean('Yes')).toBe(true);
    expect(parseBoolean('sí')).toBe(true);
    expect(parseBoolean('0')).toBe(false);
    expect(parseBoolean('')).toBe(false);
    expect(() => parseBoolean('maybe')).toThrow(CellError);
  });

  it('splits and de-duplicates tags', () => {
    expect(parseTags('vip | newsletter;vip;;')).toEqual(['vip', 'newsletter']);
  });

  it('normalizes order statuses', () => {
    expect(parseOrderStatus('Paid')).toBe('completed');
    expect(parseOrderStatus('Canceled')).toBe('cancelled');
    expect(parseOrderStatus('partially refunded')).toBe('partially_refunded');
    expect(() => parseOrderStatus('lost')).toThrow(CellError);
  });

  it('detects delimiters', () => {
    expect(detectDelimiter('id,name,email')).toBe(',');
    expect(detectDelimiter('id;name;email')).toBe(';');
    expect(detectDelimiter('id\tname\temail')).toBe('\t');
  });
});

const ctx: ParseContext = {
  options: { dateFormat: 'auto', decimalSeparator: '.', amountsInMinorUnits: false },
  timeZone: 'UTC',
  currency: 'USD',
  latestOrderAt: Date.parse('2026-11-17T00:00:00Z'),
};

describe('parseCustomerRow', () => {
  it('normalizes values and only includes mapped fields', () => {
    const result = parseCustomerRow(
      {
        externalId: 'C-1',
        email: ' Ana@Example.com ',
        country: 'co',
        tags: 'vip|new',
        marketingConsent: 'yes',
      },
      ctx,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        externalId: 'C-1',
        email: 'ana@example.com',
        country: 'CO',
        tags: ['vip', 'new'],
        marketingConsent: true,
      },
    });
  });

  it('turns empty mapped cells into nulls', () => {
    const result = parseCustomerRow({ externalId: 'C-1', firstName: 'Ana', city: '' }, ctx);
    expect(result.ok && result.value.city).toBeNull();
  });

  it('reports every problem with its field', () => {
    const result = parseCustomerRow(
      { externalId: '', email: 'nope', country: 'Colombia', registeredAt: '31/02/2026' },
      ctx,
    );
    expect(result.ok).toBe(false);
    const fields = !result.ok ? result.errors.map((e) => e.field) : [];
    expect(fields).toEqual(
      expect.arrayContaining(['externalId', 'email', 'country', 'registeredAt']),
    );
  });
});

describe('parseOrderRow', () => {
  it('parses a complete order', () => {
    const result = parseOrderRow(
      {
        externalId: 'O-1',
        customerExternalId: 'C-1',
        orderedAt: '2026-10-05 14:30',
        grossAmount: '120.00',
        discountAmount: '20',
        refundedAmount: '10',
        status: 'partially refunded',
      },
      ctx,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        externalId: 'O-1',
        customerExternalId: 'C-1',
        orderedAt: new Date('2026-10-05T14:30:00Z'),
        status: 'partially_refunded',
        channel: null,
        grossCents: 12000,
        discountCents: 2000,
        taxCents: 0,
        refundedCents: 1000,
      },
    });
  });

  it('treats an empty customer as a guest order and defaults the status', () => {
    const result = parseOrderRow(
      { externalId: 'O-2', customerExternalId: '', orderedAt: '2026-10-05', grossAmount: '5' },
      ctx,
    );
    expect(result.ok && result.value).toMatchObject({
      customerExternalId: null,
      status: 'completed',
    });
  });

  it('rejects inconsistent amounts and future dates', () => {
    const refund = parseOrderRow(
      { externalId: 'O-3', orderedAt: '2026-10-05', grossAmount: '10', refundedAmount: '11' },
      ctx,
    );
    expect(!refund.ok && refund.errors[0]?.field).toBe('refundedAmount');
    const future = parseOrderRow(
      { externalId: 'O-4', orderedAt: '2027-01-01', grossAmount: '10' },
      ctx,
    );
    expect(!future.ok && future.errors[0]?.message).toMatch(/future/);
  });
});

describe('suggestMapping', () => {
  it('maps common header names in English and Spanish', () => {
    expect(
      suggestMapping('orders', ['Order ID', 'Fecha', 'Customer_ID', 'Total', 'IVA', 'Estado']),
    ).toMatchObject({
      externalId: 'Order ID',
      orderedAt: 'Fecha',
      customerExternalId: 'Customer_ID',
      grossAmount: 'Total',
      taxAmount: 'IVA',
      status: 'Estado',
      discountAmount: null,
    });
  });

  it('never maps one column to two fields', () => {
    const mapping = suggestMapping('customers', ['id']);
    expect(Object.values(mapping).filter((v) => v === 'id')).toHaveLength(1);
  });
});
