import type { Customer, CustomerListQuery, CustomerSort, CustomerStats } from '@ci/contracts';
import { AppError } from '../../core/errors.js';
import {
  empty,
  join,
  raw,
  sql,
  toNumber,
  type SqlFragment,
  type Tx,
} from '../../infra/database.js';

/**
 * Customer reads. Purchase statistics are computed live from countable orders (always current);
 * segment, RFM scores and lifecycle status come from the latest successful analytics snapshot.
 */

interface CustomerRow {
  id: string;
  external_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  registered_at: Date | null;
  tags: string[];
  marketing_consent: boolean;
  created_at: Date;
  updated_at: Date;
  order_count: number;
  total_net: bigint;
  first_at: Date | null;
  last_at: Date | null;
  segment_key: string | null;
  r_score: number | null;
  f_score: number | null;
  m_score: number | null;
  engagement_score: number | null;
  lifecycle_status: 'PROSPECT' | 'ACTIVE' | 'AT_RISK' | 'CHURNED' | null;
  sort_value?: unknown;
}

const COUNTABLE = sql`o.deleted_at IS NULL AND o.status IN ('COMPLETED', 'PARTIALLY_REFUNDED')`;

/**
 * Sort expression and the SQL type used to bind its cursor value. Whitelisted: never user SQL.
 * Spend, order count and last purchase sort by the latest analytics snapshot (m): aggregating
 * every order of a large tenant on each page load does not scale (M9 load test: 2.6 s at 1.2M
 * orders). The figures shown for each customer are still computed live (page stats below).
 */
const SORTS: Record<
  'name' | 'created_at' | 'total_spent' | 'order_count' | 'last_order_at',
  { expr: string; cast: string }
> = {
  name: {
    expr: `lower(coalesce(c.last_name, '') || ' ' || coalesce(c.first_name, '') || ' ' || coalesce(c.email::text, ''))`,
    cast: 'text',
  },
  created_at: { expr: 'c.created_at', cast: 'timestamptz' },
  total_spent: { expr: 'coalesce(m.total_net_cents, 0)', cast: 'bigint' },
  order_count: { expr: 'coalesce(m.order_count, 0)', cast: 'int' },
  last_order_at: {
    expr: `coalesce(m.last_order_date::timestamptz, '-infinity'::timestamptz)`,
    cast: 'timestamptz',
  },
};

function parseSort(sort: CustomerSort) {
  const desc = sort.startsWith('-');
  const key = (desc ? sort.slice(1) : sort) as keyof typeof SORTS;
  return { ...SORTS[key], desc };
}

interface Cursor {
  v: string | number;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as Cursor;
    if (typeof parsed.id !== 'string' || !['string', 'number'].includes(typeof parsed.v)) throw 0;
    return parsed;
  } catch {
    throw new AppError('BAD_REQUEST', 'Invalid pagination cursor');
  }
}

function statsCte(organizationId: string, customerId?: string): SqlFragment {
  return sql`
    WITH latest_run AS (
      SELECT id FROM analytics_runs
      WHERE organization_id = ${organizationId}::uuid AND status = 'SUCCEEDED'
      ORDER BY started_at DESC LIMIT 1
    ),
    stats AS (
      SELECT o.customer_id,
             count(*)::int            AS order_count,
             sum(o.net_cents)::bigint AS total_net,
             min(o.ordered_at)        AS first_at,
             max(o.ordered_at)        AS last_at
      FROM orders o
      WHERE o.organization_id = ${organizationId}::uuid AND o.customer_id IS NOT NULL AND ${COUNTABLE}
        ${customerId ? sql`AND o.customer_id = ${customerId}::uuid` : empty}
      GROUP BY o.customer_id
    )`;
}

const SELECT_COLUMNS = sql`
  c.id, c.external_id, c.first_name, c.last_name, c.email::text AS email, c.phone, c.country,
  c.region, c.city, c.registered_at, c.tags, c.marketing_consent, c.created_at, c.updated_at,
  coalesce(s.order_count, 0) AS order_count, coalesce(s.total_net, 0)::bigint AS total_net,
  s.first_at, s.last_at, m.segment_key, m.r_score, m.f_score, m.m_score, m.engagement_score,
  m.lifecycle_status::text AS lifecycle_status`;

/** Joins the latest snapshot's metrics (no rows yet → nulls). */
const SNAPSHOT_JOIN = sql`
  LEFT JOIN analytics_customer_metrics m
    ON m.customer_id = c.id AND m.run_id = (SELECT id FROM latest_run)`;

export function toStats(
  row: Pick<CustomerRow, 'order_count' | 'total_net' | 'first_at' | 'last_at'>,
  now: number,
): CustomerStats {
  const orderCount = Number(row.order_count);
  const totalNetCents = toNumber(row.total_net);
  return {
    orderCount,
    totalNetCents,
    aovCents: orderCount > 0 ? Math.round(totalNetCents / orderCount) : null,
    firstOrderAt: row.first_at?.toISOString() ?? null,
    lastOrderAt: row.last_at?.toISOString() ?? null,
    daysSinceLastOrder: row.last_at
      ? Math.max(0, Math.floor((now - row.last_at.getTime()) / 86_400_000))
      : null,
  };
}

export function toCustomer(row: CustomerRow, now: number): Customer {
  return {
    id: row.id,
    externalId: row.external_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    country: row.country?.trim() ?? null,
    region: row.region,
    city: row.city,
    registeredAt: row.registered_at ? row.registered_at.toISOString().slice(0, 10) : null,
    tags: row.tags,
    marketingConsent: row.marketing_consent,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    stats: toStats(row, now),
    segment: row.lifecycle_status
      ? {
          key: row.segment_key,
          rScore: row.r_score,
          fScore: row.f_score,
          mScore: row.m_score,
          engagementScore: row.engagement_score,
          lifecycleStatus: row.lifecycle_status,
        }
      : null,
  };
}

export async function listCustomers(
  tx: Tx,
  organizationId: string,
  query: CustomerListQuery,
  now: number,
): Promise<{ data: Customer[]; nextCursor: string | null }> {
  const sort = parseSort(query.sort);
  const filters: SqlFragment[] = [
    sql`c.organization_id = ${organizationId}::uuid`,
    sql`c.deleted_at IS NULL`,
  ];
  if (query.q) {
    const like = `%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    // search_text is the stored lowercased name, email and external ID (see its migration).
    filters.push(sql`c.search_text LIKE lower(${like})`);
  }
  // Like the stats sorts, these filters read the latest snapshot.
  if (query.minSpentCents !== undefined)
    filters.push(sql`coalesce(m.total_net_cents, 0) >= ${query.minSpentCents}`);
  if (query.maxSpentCents !== undefined)
    filters.push(sql`coalesce(m.total_net_cents, 0) <= ${query.maxSpentCents}`);
  if (query.lastOrderFrom) filters.push(sql`m.last_order_date >= ${query.lastOrderFrom}::date`);
  if (query.lastOrderTo) filters.push(sql`m.last_order_date <= ${query.lastOrderTo}::date`);
  if (query.hasOrders === 'true') filters.push(sql`coalesce(m.order_count, 0) > 0`);
  if (query.hasOrders === 'false') filters.push(sql`coalesce(m.order_count, 0) = 0`);
  if (query.tag) filters.push(sql`${query.tag} = ANY(c.tags)`);
  if (query.segment === 'no_purchases') {
    filters.push(sql`m.lifecycle_status IS NOT NULL AND m.segment_key IS NULL`);
  } else if (query.segment) {
    filters.push(sql`m.segment_key = ${query.segment}`);
  }
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    const value = sql`${cursor.v}::${raw(sort.cast)}`;
    filters.push(
      sort.desc
        ? sql`(${raw(sort.expr)}, c.id) < (${value}, ${cursor.id}::uuid)`
        : sql`(${raw(sort.expr)}, c.id) > (${value}, ${cursor.id}::uuid)`,
    );
  }

  const direction = raw(sort.desc ? 'DESC' : 'ASC');
  // Pick the page first (customers + snapshot only), then compute live stats for those rows.
  const rows = await tx.$queryRaw<CustomerRow[]>`
    WITH latest_run AS (
      SELECT id FROM analytics_runs
      WHERE organization_id = ${organizationId}::uuid AND status = 'SUCCEEDED'
      ORDER BY started_at DESC LIMIT 1
    ),
    page AS (
      SELECT c.id, (${raw(sort.expr)})::text AS sort_value
      FROM customers c ${SNAPSHOT_JOIN}
      WHERE ${join(filters, ' AND ')}
      ORDER BY ${raw(sort.expr)} ${direction}, c.id ${direction}
      LIMIT ${query.limit + 1}
    )
    SELECT ${SELECT_COLUMNS}, page.sort_value
    FROM page
    JOIN customers c ON c.id = page.id
    ${SNAPSHOT_JOIN}
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS order_count, sum(o.net_cents)::bigint AS total_net,
             min(o.ordered_at) AS first_at, max(o.ordered_at) AS last_at
      FROM orders o
      WHERE o.organization_id = ${organizationId}::uuid AND o.customer_id = c.id AND ${COUNTABLE}
    ) s ON true
    ORDER BY ${raw(sort.expr)} ${direction}, c.id ${direction}`;

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page.map((row) => toCustomer(row, now)),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor({ v: String(last.sort_value), id: last.id })
        : null,
  };
}

export async function getCustomer(
  tx: Tx,
  organizationId: string,
  customerId: string,
  now: number,
  { includeDeleted = false } = {},
): Promise<Customer | null> {
  const rows = await tx.$queryRaw<CustomerRow[]>`
    ${statsCte(organizationId, customerId)}
    SELECT ${SELECT_COLUMNS}
    FROM customers c LEFT JOIN stats s ON s.customer_id = c.id ${SNAPSHOT_JOIN}
    WHERE c.organization_id = ${organizationId}::uuid AND c.id = ${customerId}::uuid
      ${includeDeleted ? empty : sql`AND c.deleted_at IS NULL`}`;
  return rows[0] ? toCustomer(rows[0], now) : null;
}
