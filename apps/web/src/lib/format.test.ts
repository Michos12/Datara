import { describe, expect, it } from 'vitest';
import { formatMoney, formatNumber, formatPercent, formatPointChange } from './format';

describe('formatMoney', () => {
  it('converts integer cents to currency', () => {
    expect(formatMoney(523_99, 'USD', { locale: 'en-US' })).toBe('$523.99');
  });

  it('respects currencies without minor units', () => {
    // JPY has 0 fraction digits, so the stored minor unit is the yen itself.
    expect(formatMoney(1500, 'JPY', { locale: 'en-US' })).toBe('¥1,500');
  });

  it('accepts bigint amounts from the API', () => {
    expect(formatMoney(12_345_678n, 'EUR', { locale: 'de-DE' })).toBe('123.456,78 €');
  });

  it('supports compact notation for axes', () => {
    expect(formatMoney(2_480_000, 'USD', { locale: 'en-US', compact: true })).toBe('$24.8K');
  });
});

describe('percentages', () => {
  it('formats a ratio with one decimal', () => {
    expect(formatPercent(0.4123, { locale: 'en-US' })).toBe('41.2%');
  });

  it('formats percentage-point changes with a sign', () => {
    expect(formatPointChange(0.412, 0.43, { locale: 'en-US' })).toBe('-1.8 pts');
    expect(formatPointChange(0.45, 0.43, { locale: 'en-US' })).toBe('+2.0 pts');
    expect(formatPointChange(0.43, 0.43, { locale: 'en-US' })).toBe('0.0 pts');
  });
});

describe('formatNumber', () => {
  it('uses locale grouping', () => {
    expect(formatNumber(4120, { locale: 'en-US' })).toBe('4,120');
  });
});

describe('formatMoney minor units (ISO 4217, shared with the API)', () => {
  it('treats COP amounts as centavos even though Intl displays whole pesos', () => {
    expect(formatMoney(1_200_000, 'COP', { locale: 'en-US' })).toMatch(/^COP\s12,000$/);
  });
});
