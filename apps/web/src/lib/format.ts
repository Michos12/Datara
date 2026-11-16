/**
 * Locale-aware formatting. Money is always integer minor units (cents) plus an ISO-4217 code
 * (docs/03-data-model.md §1); never format floats as money.
 */

const DEFAULT_LOCALE = typeof navigator !== 'undefined' ? navigator.language : 'en-US';

function minorUnitDigits(currency: string, locale: string): number {
  return (
    new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

export function formatMoney(
  cents: number | bigint,
  currency: string,
  { locale = DEFAULT_LOCALE, compact = false }: { locale?: string; compact?: boolean } = {},
): string {
  const digits = minorUnitDigits(currency, locale);
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
