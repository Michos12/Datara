/**
 * Period presets resolved in the organization's time zone, as [start, end) ISO dates.
 * Pure functions so the date arithmetic is unit-tested.
 */

export const PRESETS = [
  'last_month',
  'this_month',
  'last_3_months',
  'last_12_months',
  'year_to_date',
  'custom',
] as const;
export type Preset = (typeof PRESETS)[number];

export interface Range {
  start: string;
  end: string;
}

/** Today's calendar date in `timeZone`, e.g. "2026-11-16". */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function parts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return [y, m, d];
}

function iso(y: number, m: number, d: number): string {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  const [y, m, d] = parts(day);
  return iso(y, m, d + days);
}

export function monthStart(day: string, offsetMonths = 0): string {
  const [y, m] = parts(day);
  return iso(y, m + offsetMonths, 1);
}

export function resolvePreset(preset: Exclude<Preset, 'custom'>, today: string): Range {
  const thisMonth = monthStart(today);
  switch (preset) {
    case 'last_month':
      return { start: monthStart(today, -1), end: thisMonth };
    case 'this_month':
      return { start: thisMonth, end: addDays(today, 1) };
    case 'last_3_months':
      return { start: monthStart(today, -3), end: thisMonth };
    case 'last_12_months':
      return { start: monthStart(today, -12), end: thisMonth };
    case 'year_to_date':
      return { start: `${today.slice(0, 4)}-01-01`, end: addDays(today, 1) };
  }
}

/** Inclusive last day of a half-open range, for display. */
export function lastDay(range: Range): string {
  return addDays(range.end, -1);
}

/** Short label for a chart bucket starting on `period` ("Oct 26" for months, "Oct 6" for days). */
export function bucketLabel(period: string, grain: string, locale?: string): string {
  const date = new Date(`${period}T00:00:00Z`);
  const opts: Intl.DateTimeFormatOptions =
    grain === 'month' || grain === 'quarter'
      ? { month: 'short', year: '2-digit', timeZone: 'UTC' }
      : { month: 'short', day: 'numeric', timeZone: 'UTC' };
  return new Intl.DateTimeFormat(locale, opts).format(date);
}
