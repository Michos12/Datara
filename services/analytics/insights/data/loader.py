"""Loads one organization's data as typed DataFrames (SQL does the heavy aggregation).

`purchases` has one row per (customer, local purchase day): orders are already filtered to
countable statuses, converted to the organization's time zone and summed in SQL, so a tenant
with millions of orders yields a frame of at most customers × active days.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any
from uuid import UUID

import pandas as pd
import psycopg

from insights.settings import AnalyticsSettings, resolve_settings

PURCHASES_SQL = """
SELECT CASE WHEN c.id IS NOT NULL AND c.deleted_at IS NULL THEN o.customer_id::text END
         AS customer_id,
       (o.ordered_at AT TIME ZONE %(tz)s)::date AS day,
       count(*)::int AS orders,
       sum(o.net_cents)::bigint AS net
FROM orders o
LEFT JOIN customers c ON c.id = o.customer_id
WHERE o.organization_id = %(org)s
  AND o.deleted_at IS NULL
  AND o.status IN ('COMPLETED', 'PARTIALLY_REFUNDED')
  AND o.ordered_at <= now() + interval '1 day'
GROUP BY 1, 2
"""

CUSTOMERS_SQL = """
SELECT id::text AS customer_id,
       (created_at AT TIME ZONE %(tz)s)::date AS created_day,
       registered_at
FROM customers
WHERE organization_id = %(org)s AND deleted_at IS NULL
"""

QUALITY_SQL = """
SELECT
  count(*) FILTER (WHERE deleted_at IS NULL)                                    AS orders_total,
  count(*) FILTER (WHERE deleted_at IS NOT NULL)                                AS deleted,
  count(*) FILTER (WHERE deleted_at IS NULL AND status = 'CANCELLED')           AS cancelled,
  count(*) FILTER (WHERE deleted_at IS NULL AND status = 'REFUNDED')            AS refunded,
  count(*) FILTER (WHERE deleted_at IS NULL AND status = 'PENDING')             AS pending,
  count(*) FILTER (WHERE deleted_at IS NULL AND ordered_at > now() + interval '1 day')
                                                                                AS future_dated,
  count(*) FILTER (WHERE deleted_at IS NULL AND status IN ('COMPLETED', 'PARTIALLY_REFUNDED')
                     AND net_cents = 0)                                         AS zero_value,
  count(*) FILTER (WHERE deleted_at IS NULL AND status IN ('COMPLETED', 'PARTIALLY_REFUNDED')
                     AND customer_id IS NULL)                                   AS guest_orders,
  count(*) FILTER (WHERE deleted_at IS NULL AND status IN ('COMPLETED', 'PARTIALLY_REFUNDED'))
                                                                                AS countable
FROM orders WHERE organization_id = %(org)s
"""

DUPLICATES_SQL = """
SELECT coalesce(sum(n - 1), 0)::int FROM (
  SELECT count(*) AS n FROM orders
  WHERE organization_id = %(org)s AND deleted_at IS NULL AND customer_id IS NOT NULL
  GROUP BY customer_id, ordered_at, net_cents HAVING count(*) > 1
) d
"""

# MATERIALIZED: computed once. Inlined, Postgres re-evaluated the percentile per row (23 s vs 6 ms
# on 7,600 orders).
OUTLIERS_SQL = """
WITH t AS MATERIALIZED (
  SELECT percentile_cont(0.999) WITHIN GROUP (ORDER BY net_cents) AS p FROM orders
  WHERE organization_id = %(org)s AND deleted_at IS NULL
    AND status IN ('COMPLETED', 'PARTIALLY_REFUNDED')
)
SELECT count(*)::int FROM orders, t
WHERE organization_id = %(org)s AND deleted_at IS NULL
  AND status IN ('COMPLETED', 'PARTIALLY_REFUNDED') AND t.p > 0 AND net_cents > t.p * 10
"""


@dataclass
class OrgData:
    organization_id: UUID
    data_version: int
    timezone: str
    currency: str
    settings: AnalyticsSettings
    purchases: pd.DataFrame
    """customer_id (str | None), day (datetime64), orders (int), net (int)"""
    customers: pd.DataFrame
    """customer_id, since (datetime64): the customer's start date (see `customer_since`)"""
    extra: dict[str, Any] = field(default_factory=dict)


def load_org(conn: psycopg.Connection, organization_id: UUID) -> OrgData:
    """Reads everything the metrics need. `conn` must be inside a tenant transaction."""
    row = conn.execute(
        "SELECT timezone, currency, industry, settings, data_version FROM organizations"
        " WHERE id = %s",
        (organization_id,),
    ).fetchone()
    if row is None:
        raise LookupError(f"Organization {organization_id} not found")
    timezone, currency, industry, raw_settings, data_version = row
    params = {"org": organization_id, "tz": timezone}

    with conn.cursor() as cur:
        cur.execute(PURCHASES_SQL, params)
        purchases = pd.DataFrame(cur.fetchall(), columns=["customer_id", "day", "orders", "net"])
        cur.execute(CUSTOMERS_SQL, params)
        customers = pd.DataFrame(
            cur.fetchall(), columns=["customer_id", "created_day", "registered_at"]
        )

    purchases = purchases.astype({"orders": "int64", "net": "int64"})
    purchases["day"] = pd.to_datetime(purchases["day"])
    purchases = purchases.sort_values(["day"], kind="stable").reset_index(drop=True)
    customers = customer_since(customers, purchases)

    return OrgData(
        organization_id=organization_id,
        data_version=int(data_version),
        timezone=str(timezone),
        currency=str(currency).strip(),
        settings=resolve_settings(str(industry), raw_settings),
        purchases=purchases,
        customers=customers,
    )


def customer_since(customers: pd.DataFrame, purchases: pd.DataFrame) -> pd.DataFrame:
    """A customer's start date: the earliest of registration and first purchase, falling back to
    the record's creation date. Imported historical customers are therefore counted from when they
    really became customers, not from the import date."""
    first = purchases.dropna(subset=["customer_id"]).groupby("customer_id")["day"].min()
    out = customers[["customer_id"]].copy()
    registered = pd.to_datetime(customers["registered_at"])
    created = pd.to_datetime(customers["created_day"])
    first_purchase = customers["customer_id"].map(first)
    since = pd.concat([registered, first_purchase], axis=1).min(axis=1)
    out["since"] = pd.to_datetime(since.fillna(created))
    return out.reset_index(drop=True)


def data_quality(conn: psycopg.Connection, organization_id: UUID) -> dict[str, Any]:
    """Counts of excluded and suspicious rows (docs/05-analytics-methodology.md §3)."""
    params = {"org": organization_id}
    with conn.cursor() as cur:
        cur.execute(QUALITY_SQL, params)
        names = [d.name for d in cur.description or []]
        values = cur.fetchone() or ()
        report: dict[str, Any] = {k: int(v or 0) for k, v in zip(names, values, strict=True)}
        cur.execute(DUPLICATES_SQL, params)
        report["suspected_duplicates"] = int((cur.fetchone() or (0,))[0])
        cur.execute(OUTLIERS_SQL, params)
        report["outliers"] = int((cur.fetchone() or (0,))[0])
    countable = report["countable"]
    report["guest_share"] = round(report["guest_orders"] / countable, 4) if countable else 0.0
    return report


def as_date(value: Any) -> date:
    return pd.Timestamp(value).date()
