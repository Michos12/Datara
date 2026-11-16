import {
  createCustomerRequestSchema,
  currencyMinorUnits,
  orderStatusSchema,
  type ImportEntity,
  type ImportOptions,
  type OrderStatus,
} from '@ci/contracts';

/**
 * Pure functions that turn CSV cells into typed values. No I/O, so they are unit-tested in
 * isolation. Every failure becomes a readable, field-level message for the import report.
 */

export class CellError extends Error {}

// ───────────── amounts ─────────────

/** Number of minor-unit digits for a currency (ISO 4217: USD 2, JPY 0, KWD 3). */
export const currencyDigits = currencyMinorUnits;

/**
 * Parses "1,234.50", "$ 1.234,50" (with decimalSeparator ","), "12 000" or "COP 12000" into
 * integer minor units without floating-point arithmetic.
 */
export function parseAmount(
  raw: string,
  options: { decimalSeparator: '.' | ','; currency: string; inMinorUnits: boolean },
): number {
  let text = raw.trim().replace(/[\s�'’]/g, '');
  if (text.startsWith('(') && text.endsWith(')')) throw new CellError('Must not be negative');
  text = text.replace(/^[^\d\-+.,]+|[^\d.,]+$/g, ''); // currency symbols or codes around the number
  if (text.startsWith('-')) throw new CellError('Must not be negative');
  text = text.replace(/^\+/, '');

  if (options.decimalSeparator === '.') text = text.replace(/,/g, '');
  else text = text.replace(/\./g, '').replace(',', '.');

  if (!/^\d+(\.\d+)?$/.test(text)) throw new CellError(`"${raw}" is not a valid amount`);
  const [whole, fraction = ''] = text.split('.') as [string, string?];

  if (options.inMinorUnits) {
    if (fraction && !/^0+$/.test(fraction)) {
      throw new CellError('Expected whole minor units (e.g. cents) without decimals');
    }
    return toSafeInteger(BigInt(whole));
  }

  const digits = currencyDigits(options.currency);
  if (fraction.replace(/0+$/, '').length > digits) {
    throw new CellError(`Too many decimals for ${options.currency} (max ${digits})`);
  }
  const minor =
    BigInt(whole) * 10n ** BigInt(digits) +
    BigInt((fraction + '0'.repeat(digits)).slice(0, digits) || '0');
  return toSafeInteger(minor);
}

function toSafeInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new CellError('Amount is too large');
  return Number(value);
}

// ───────────── dates ─────────────

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(epochMs: number, timeZone: string) {
  const parts = Object.fromEntries(
    zoneFormatter(timeZone)
      .formatToParts(new Date(epochMs))
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function offsetMs(epochMs: number, timeZone: string): number {
  const p = zonedParts(epochMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * The UTC instant of a wall-clock time in a time zone. Handles DST: a time that falls in a
 * spring-forward gap resolves to the instant after the gap.
 */
export function zonedTimeToUtc(
  parts: {
    year: number;
    month: number;
    day: number;
    hour?: number;
    minute?: number;
    second?: number;
  },
  timeZone: string,
): Date {
  const guess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  const first = offsetMs(guess, timeZone);
  let result = guess - first;
  const second = offsetMs(result, timeZone);
  if (second !== first) result = guess - second;
  return new Date(result);
}

function isRealDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_LOCAL = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const SEPARATED = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Parses a cell into an instant. Values without an offset are wall-clock time in `timeZone`. */
export function parseDateTime(
  raw: string,
  options: { dateFormat: ImportOptions['dateFormat']; timeZone: string },
): Date {
  const text = raw.trim();
  if (ISO_WITH_ZONE.test(text)) {
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) throw new CellError(`"${raw}" is not a valid date`);
    return date;
  }
  return zonedTimeToUtc(parseLocal(text, options.dateFormat), options.timeZone);
}

/** Parses a cell into a calendar date (YYYY-MM-DD) as seen in `timeZone`. */
export function parseDateOnly(
  raw: string,
  options: { dateFormat: ImportOptions['dateFormat']; timeZone: string },
): string {
  const text = raw.trim();
  if (ISO_WITH_ZONE.test(text)) {
    const p = zonedParts(parseDateTime(text, options).getTime(), options.timeZone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  }
  const p = parseLocal(text, options.dateFormat);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function parseLocal(text: string, format: ImportOptions['dateFormat']): LocalDateTime {
  let year: number;
  let month: number;
  let day: number;
  let time: (string | undefined)[];

  const iso = ISO_LOCAL.exec(text);
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    time = iso.slice(4);
  } else {
    const m = SEPARATED.exec(text);
    if (!m) throw new CellError(`"${text}" is not a recognised date`);
    const [a, b, c] = [m[1]!, m[2]!, m[3]!];
    time = m.slice(4);
    if (a.length === 4) {
      [year, month, day] = [Number(a), Number(b), Number(c)];
    } else {
      const first = Number(a);
      const second = Number(b);
      let order = format === 'auto' ? null : format;
      if (!order) {
        if (first > 12 && second <= 12) order = 'DMY';
        else if (second > 12 && first <= 12) order = 'MDY';
        else {
          throw new CellError(
            `"${text}" is ambiguous (day/month or month/day?). Choose a date format for this import.`,
          );
        }
      }
      if (order === 'YMD')
        throw new CellError(`"${text}" does not match the year-month-day format`);
      [day, month] = order === 'DMY' ? [first, second] : [second, first];
      year = c.length === 2 ? 2000 + Number(c) : Number(c);
    }
  }

  const [h, mi, s] = time.map((v) => (v === undefined ? 0 : Number(v))) as [number, number, number];
  if (!isRealDate(year, month, day) || year < 1900 || year > 2200) {
    throw new CellError(`"${text}" is not a valid date`);
  }
  if (h > 23 || mi > 59 || s > 59) throw new CellError(`"${text}" has an invalid time`);
  return { year, month, day, hour: h, minute: mi, second: s };
}

// ───────────── other cells ─────────────

const TRUE = new Set(['true', 'yes', 'y', '1', 'si', 'sí', 'x']);
const FALSE = new Set(['false', 'no', 'n', '0', '']);

export function parseBoolean(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (TRUE.has(value)) return true;
  if (FALSE.has(value)) return false;
  throw new CellError(`"${raw}" is not yes/no`);
}

export function parseTags(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[|;]/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);
}

const STATUS_ALIASES: Record<string, OrderStatus> = {
  completed: 'completed',
  complete: 'completed',
  paid: 'completed',
  fulfilled: 'completed',
  delivered: 'completed',
  closed: 'completed',
  pending: 'pending',
  processing: 'pending',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  voided: 'cancelled',
  refunded: 'refunded',
  partiallyrefunded: 'partially_refunded',
  partialrefund: 'partially_refunded',
};

export function parseOrderStatus(raw: string): OrderStatus {
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  const status = STATUS_ALIASES[key] ?? orderStatusSchema.safeParse(raw.trim().toLowerCase()).data;
  if (!status) throw new CellError(`Unknown status "${raw}"`);
  return status;
}

// ───────────── rows ─────────────

export interface RowError {
  field: string | null;
  message: string;
}

export interface ParsedCustomer {
  externalId: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  registeredAt?: string | null;
  tags?: string[];
  marketingConsent?: boolean;
}

export interface ParsedOrder {
  externalId: string;
  customerExternalId: string | null;
  orderedAt: Date;
  status: OrderStatus;
  channel: string | null;
  grossCents: number;
  discountCents: number;
  taxCents: number;
  refundedCents: number;
}

export interface ParseContext {
  options: ImportOptions;
  timeZone: string;
  currency: string;
  /** Instant after which order dates are rejected (now + 1 day). */
  latestOrderAt: number;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: RowError[] };

/** Cells by field key, already looked up through the column mapping; unmapped fields absent. */
export type MappedRow = Record<string, string | undefined>;

function cell(row: MappedRow, key: string): string | undefined {
  const value = row[key];
  return value === undefined ? undefined : value.trim();
}

function collect<T>(errors: RowError[], field: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    errors.push({ field, message: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

export function parseCustomerRow(row: MappedRow, ctx: ParseContext): ParseResult<ParsedCustomer> {
  const errors: RowError[] = [];
  const externalId = cell(row, 'externalId');
  if (!externalId) errors.push({ field: 'externalId', message: 'Customer ID is required' });

  const candidate: Record<string, unknown> = {};
  for (const key of ['firstName', 'lastName', 'email', 'phone', 'country', 'region', 'city']) {
    const value = cell(row, key);
    if (value !== undefined) candidate[key] = value === '' ? null : value;
  }
  const registered = cell(row, 'registeredAt');
  if (registered !== undefined) {
    candidate.registeredAt = registered
      ? collect(errors, 'registeredAt', () =>
          parseDateOnly(registered, { dateFormat: ctx.options.dateFormat, timeZone: ctx.timeZone }),
        )
      : null;
  }
  const tags = cell(row, 'tags');
  if (tags !== undefined) candidate.tags = parseTags(tags);
  const consent = cell(row, 'marketingConsent');
  if (consent !== undefined) {
    candidate.marketingConsent = collect(errors, 'marketingConsent', () => parseBoolean(consent));
  }

  // Reuse the API's validation for emails, country codes and lengths.
  const validated = createCustomerRequestSchema.safeParse({ ...candidate, externalId });
  if (!validated.success) {
    for (const issue of validated.error.issues) {
      const field = String(issue.path[0] ?? '');
      if (field === 'registeredAt' && errors.some((e) => e.field === 'registeredAt')) continue;
      errors.push({ field: field || null, message: issue.message });
    }
  }
  if (errors.length > 0 || !validated.success) return { ok: false, errors };

  const value: ParsedCustomer = { externalId: externalId! };
  for (const key of Object.keys(candidate) as (keyof ParsedCustomer)[]) {
    (value as unknown as Record<string, unknown>)[key] =
      validated.data[key as keyof typeof validated.data] ?? null;
  }
  return { ok: true, value };
}

export function parseOrderRow(row: MappedRow, ctx: ParseContext): ParseResult<ParsedOrder> {
  const errors: RowError[] = [];
  const externalId = cell(row, 'externalId');
  if (!externalId) errors.push({ field: 'externalId', message: 'Order ID is required' });
  else if (externalId.length > 120) errors.push({ field: 'externalId', message: 'Too long' });

  const rawDate = cell(row, 'orderedAt');
  let orderedAt: Date | undefined;
  if (!rawDate) errors.push({ field: 'orderedAt', message: 'Order date is required' });
  else {
    orderedAt = collect(errors, 'orderedAt', () =>
      parseDateTime(rawDate, { dateFormat: ctx.options.dateFormat, timeZone: ctx.timeZone }),
    );
    if (orderedAt && orderedAt.getTime() > ctx.latestOrderAt) {
      errors.push({ field: 'orderedAt', message: 'Order date is in the future' });
    }
  }

  const amountOptions = {
    decimalSeparator: ctx.options.decimalSeparator,
    currency: ctx.currency,
    inMinorUnits: ctx.options.amountsInMinorUnits,
  };
  const amount = (key: string, required: boolean): number | undefined => {
    const raw = cell(row, key);
    if (!raw) {
      if (required) errors.push({ field: key, message: 'Order total is required' });
      return required ? undefined : 0;
    }
    return collect(errors, key, () => parseAmount(raw, amountOptions));
  };
  const gross = amount('grossAmount', true);
  const discount = amount('discountAmount', false);
  const tax = amount('taxAmount', false);
  const refunded = amount('refundedAmount', false);

  const rawStatus = cell(row, 'status');
  const status = rawStatus
    ? collect(errors, 'status', () => parseOrderStatus(rawStatus))
    : 'completed';

  if (gross !== undefined && discount !== undefined && discount > gross) {
    errors.push({ field: 'discountAmount', message: 'Discount is larger than the order total' });
  } else if (
    gross !== undefined &&
    discount !== undefined &&
    refunded !== undefined &&
    refunded > gross - discount
  ) {
    errors.push({ field: 'refundedAmount', message: 'Refund is larger than the amount paid' });
  }

  const channel = cell(row, 'channel');
  if (channel && channel.length > 40) errors.push({ field: 'channel', message: 'Too long' });

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      externalId: externalId!,
      customerExternalId: cell(row, 'customerExternalId') || null,
      orderedAt: orderedAt!,
      status: status!,
      channel: channel || null,
      grossCents: gross!,
      discountCents: discount!,
      taxCents: tax!,
      refundedCents: refunded!,
    },
  };
}

export function parseRow(entity: ImportEntity, row: MappedRow, ctx: ParseContext) {
  return entity === 'customers' ? parseCustomerRow(row, ctx) : parseOrderRow(row, ctx);
}

/** Detects the delimiter from the header line: whichever of , ; tab | appears most. */
export function detectDelimiter(headerLine: string): string {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = headerLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}
