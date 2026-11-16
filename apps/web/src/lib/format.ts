import { currencyMinorUnits } from '@ci/contracts';

/**
 * Locale-aware formatting. Money is always integer minor units (cents) plus an ISO-4217 code
 * (docs/03-data-model.md §1); never format floats as money.
 */

const DEFAULT_LOCALE = typeof navigator !== 'undefined' ? navigator.language : 'en-US';

export function formatMoney(
  cents: number | bigint,
  currency: string,
  { locale = DEFAULT_LOCALE, compact = false }: { locale?: string; compact?: boolean } = {},
): string {
  const digits = currencyMinorUnits(currency);
  const amount = Number(cents) / 10 ** digits;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    ...(compact ? { notation: 'compact', maximumFractionDigits: 1 } : {}),
  }).format(amount);
}

export function formatNumber(
  value: number,
  { locale = DEFAULT_LOCALE, compact = false }: { locale?: string; compact?: boolean } = {},
): string {
  return new Intl.NumberFormat(locale, compact ? { notation: 'compact' } : {}).format(value);
}

/** `ratio` is 0..1. Rates are shown with one decimal (e.g. 41.2%). */
export function formatPercent(
  ratio: number,
  { locale = DEFAULT_LOCALE, digits = 1 }: { locale?: string; digits?: number } = {},
): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(ratio);
}

/** Percentage-point change between two rates, e.g. 0.412 vs 0.430 → "−1.8 pts". */
export function formatPointChange(
  current: number,
  previous: number,
  { locale = DEFAULT_LOCALE }: { locale?: string } = {},
): string {
  const points = (current - previous) * 100;
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  }).format(points);
  return `${formatted} pts`;
}

/**
 * Parses what a person types as an amount ("12.50", "1,250") into integer minor units.
 * Returns null for empty or invalid input. Uses the ISO 4217 minor units shared with the API.
 */
export function parseMoneyInput(text: string, currency: string): number | null {
  const cleaned = text.trim().replace(/[\s,]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const digits = currencyMinorUnits(currency);
  const [whole, fraction = ''] = cleaned.split('.') as [string, string?];
  if (fraction.length > digits) return null;
  return (
    Number(whole) * 10 ** digits + Number((fraction + '0'.repeat(digits)).slice(0, digits) || '0')
  );
}

/** Minor units → plain decimal string for an input field (no symbols or grouping). */
export function minorToInput(cents: number, currency: string): string {
  const digits = currencyMinorUnits(currency);
  return (cents / 10 ** digits).toFixed(digits);
}

export function formatDate(iso: string | null, locale = DEFAULT_LOCALE, timeZone?: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

export function formatDateTime(iso: string, locale = DEFAULT_LOCALE, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}
