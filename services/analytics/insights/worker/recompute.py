"""`analytics.recompute`: writes an analytics snapshot (docs/02-architecture.md §6).

A run reads the data, computes per-customer metrics and monthly period metrics, stores them
with the definition versions and data version used, and schedules the next nightly run.
Each organization's runs keep their own schedule going, so no cross-tenant query is needed.
"""

from __future__ import annotations

import time
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import psycopg
from psycopg.types.json import Jsonb

from insights.data.loader import OrgData, data_quality, load_org
from insights.db import Database
from insights.definitions import DEFINITION_VERSIONS
from insights.ids import uuid7
from insights.logging import get_logger
from insights.metrics.core import Ratio, customer_metrics, lifecycle_counts, period_kpis
from insights.metrics.rfm import rfm
from insights.periods import Period, add_months, buckets, today_in
from insights.segments import load_active_segment_config
from insights.worker.queue import Job

log = get_logger("insights.worker.recompute")

RECOMPUTE_JOB = "analytics.recompute"
TREND_MONTHS = 24
KEEP_RUNS = 7
NIGHTLY_HOUR = 2
BATCH = 1000

SCHEDULE_SQL = """
INSERT INTO jobs (id, organization_id, type, payload, run_after)
VALUES (%s, %s, 'analytics.recompute', %s, %s)
ON CONFLICT (organization_id, type) WHERE status = 'PENDING' AND type = 'analytics.recompute'
DO UPDATE SET run_after = LEAST(jobs.run_after, EXCLUDED.run_after)
"""

PERIOD_METRIC_KEYS = (
    "revenue_net",
    "orders",
    "aov",
    "buyers",
    "new_customers",
    "returning_customers",
    "retention_rate",
    "churn_rate",
    "active_customers",
    "total_customers",
)


def schedule_recompute(
    conn: psycopg.Connection, organization_id: UUID, run_after: datetime, trigger: str
) -> None:
    """Queues a recompute, or moves an already pending one earlier (one pending per org)."""
    conn.execute(SCHEDULE_SQL, (uuid7(), organization_id, Jsonb({"trigger": trigger}), run_after))


def next_nightly(timezone: str, now: datetime | None = None) -> datetime:
    """Tomorrow at 02:00 in the organization's time zone, as UTC."""
    moment = (now or datetime.now(UTC)).astimezone(ZoneInfo(timezone))
    target = (moment + timedelta(days=1)).replace(
        hour=NIGHTLY_HOUR, minute=0, second=0, microsecond=0
    )
    return target.astimezone(UTC)


def period_metric_rows(data: OrgData, today: date) -> list[dict[str, Any]]:
    """Monthly series for the last TREND_MONTHS months (current month to date)."""
    start = add_months(today.replace(day=1), -(TREND_MONTHS - 1))
    window = Period(start, add_months(today.replace(day=1), 1))
    rows: list[dict[str, Any]] = []
    for month in buckets(window, "month"):
        as_of = min(month.last_day, today)
        kpis = period_kpis(data.purchases, data.customers, month, data.settings, as_of)
        for key in PERIOD_METRIC_KEYS:
            raw = kpis[key]
            if isinstance(raw, Ratio):
                value, num, den = raw.value, raw.numerator, raw.denominator
            else:
                value, num, den = raw, None, None
            rows.append(
                {"period_start": month.start, "metric_key": key, "value": value,
                 "numerator": num, "denominator": den}
            )  # fmt: skip
    return rows


def _none(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, float) and np.isnan(value):
        return None
    if value is pd.NaT:
        return None
    return value


def _int(value: Any) -> int | None:
    return None if value is None or pd.isna(value) else int(value)


def _rounded(value: Any, digits: int) -> float | None:
    return None if pd.isna(value) else round(float(value), digits)


def _day(value: Any) -> date | None:
    value = _none(value)
    return None if value is None or pd.isna(value) else pd.Timestamp(value).date()


def recompute(job: Job, db: Database) -> None:
    if job.organization_id is None:
        raise ValueError("recompute job needs an organization")
    org = job.organization_id
    started = time.perf_counter()
    run_id = uuid7()

    with db.tenant_transaction(org) as conn:
        data = load_org(conn, org)
        quality = data_quality(conn, org)
        segment_config = load_active_segment_config(conn, org)
        today = today_in(data.timezone)
        conn.execute(
            "INSERT INTO analytics_runs (id, organization_id, as_of, data_version, status,"
            " definition_versions, settings, segment_config_id, segment_config_version)"
            " VALUES (%s, %s, %s, %s, 'RUNNING', %s, %s, %s, %s)",
            (run_id, org, today, data.data_version, Jsonb(DEFINITION_VERSIONS),
             Jsonb(data.settings.to_dict()),
             segment_config.id if segment_config else None,
             segment_config.version if segment_config else None),
        )  # fmt: skip
    loaded = time.perf_counter()

    try:
        metrics = customer_metrics(data.purchases, data.customers, today, data.settings)
        if segment_config:
            segmented = rfm(
                data.purchases,
                data.customers,
                today,
                data.settings.recency_cut_points,
                segment_config.config,
            )
            metrics = metrics.merge(
                segmented.drop(columns=["recency_days"]), on="customer_id", how="left"
            )
        else:
            for column in ("f_value", "m_value", "r_score", "f_score", "m_score", "segment_key"):
                metrics[column] = None
        series = period_metric_rows(data, today)
        computed = time.perf_counter()

        with db.tenant_transaction(org) as conn:
            _write_customer_metrics(conn, run_id, org, metrics)
            _write_period_metrics(conn, run_id, org, series)
            stats = {
                "customers": len(metrics),
                "purchase_rows": len(data.purchases),
                "lifecycle": lifecycle_counts(metrics),
                "segments": {
                    str(k): int(v) for k, v in metrics["segment_key"].value_counts().items()
                },
                "seconds": {
                    "load": round(loaded - started, 3),
                    "compute": round(computed - loaded, 3),
                    "write": round(time.perf_counter() - computed, 3),
                },
            }
            conn.execute(
                "UPDATE analytics_runs SET status = 'SUCCEEDED', finished_at = now(),"
                " data_quality = %s, stats = %s WHERE id = %s",
                (Jsonb(quality), Jsonb(stats), run_id),
            )
            _prune(conn, org)
            schedule_recompute(conn, org, next_nightly(data.timezone), "nightly")
        log.info("recompute succeeded", organization_id=str(org), run_id=str(run_id), **stats)
    except Exception as exc:
        with db.tenant_transaction(org) as conn:
            conn.execute(
                "UPDATE analytics_runs SET status = 'FAILED', finished_at = now(), error = %s"
                " WHERE id = %s",
                (str(exc)[:500], run_id),
            )
        raise


def _write_customer_metrics(
    conn: psycopg.Connection, run_id: UUID, org: UUID, metrics: pd.DataFrame
) -> None:
    sql = (
        "INSERT INTO analytics_customer_metrics (run_id, customer_id, organization_id,"
        " order_count, total_net_cents, aov_cents, first_order_date, last_order_date,"
        " recency_days, tenure_days, frequency_per_month, median_gap_days, lifecycle_status,"
        " historical_clv_cents, f_value, m_value_cents, r_score, f_score, m_score, segment_key)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,"
        ' %s::"LifecycleStatus", %s, %s, %s, %s, %s, %s, %s)'
    )
    params = []
    for r in metrics.to_dict("records"):
        params.append(
            (run_id, r["customer_id"], org, int(r["order_count"]), int(r["total_net"]),
             None if pd.isna(r["aov"]) else int(r["aov"]),
             _day(r["first_day"]), _day(r["last_day"]),
             None if pd.isna(r["recency_days"]) else int(r["recency_days"]),
             None if pd.isna(r["tenure_days"]) else int(r["tenure_days"]),
             _rounded(r["frequency_per_month"], 4),
             _rounded(r["median_gap"], 2),
             r["lifecycle_status"], int(r["historical_clv"]),
             _int(r["f_value"]), _int(r["m_value"]), _int(r["r_score"]), _int(r["f_score"]),
             _int(r["m_score"]), _none(r["segment_key"]))
        )  # fmt: skip
    with conn.cursor() as cur:
        for start in range(0, len(params), BATCH):
            cur.executemany(sql, params[start : start + BATCH])


def _write_period_metrics(
    conn: psycopg.Connection, run_id: UUID, org: UUID, rows: list[dict[str, Any]]
) -> None:
    sql = (
        "INSERT INTO analytics_period_metrics (run_id, organization_id, grain, period_start,"
        " metric_key, value, numerator, denominator) VALUES (%s, %s, 'MONTH', %s, %s, %s, %s, %s)"
    )
    with conn.cursor() as cur:
        cur.executemany(
            sql,
            [
                (run_id, org, r["period_start"], r["metric_key"], _none(r["value"]),
                 r["numerator"], r["denominator"])
                for r in rows
            ],
        )  # fmt: skip


def _prune(conn: psycopg.Connection, org: UUID) -> None:
    """Keeps the latest KEEP_RUNS succeeded runs (longer retention policy: M9)."""
    old = conn.execute(
        "SELECT id FROM analytics_runs WHERE organization_id = %s ORDER BY started_at DESC"
        " OFFSET %s",
        (org, KEEP_RUNS),
    ).fetchall()
    ids = [row[0] for row in old]
    if not ids:
        return
    for table in ("analytics_customer_metrics", "analytics_period_metrics"):
        conn.execute(f"DELETE FROM {table} WHERE run_id = ANY(%s)", (ids,))  # noqa: S608
    conn.execute("DELETE FROM analytics_runs WHERE id = ANY(%s)", (ids,))
