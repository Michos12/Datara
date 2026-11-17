"""Runs the rules on a snapshot, scores priority, and reconciles findings with stored
recommendations (docs/05-analytics-methodology.md §10).

`reconcile` is pure, so the lifecycle (deduplication, expiry, dismissal cooldown) is tested
without a database; `save` applies its plan inside the run's tenant transaction.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any
from uuid import UUID

import pandas as pd
import psycopg
from psycopg.types.json import Jsonb

from insights.ids import uuid7
from insights.logging import get_logger
from insights.metrics.core import ts
from insights.recommendations.rules import (
    RULES,
    TRAILING_DAYS,
    Finding,
    RuleContext,
)
from insights.settings import AnalyticsSettings

log = get_logger("insights.recommendations")

HIGH_IMPACT = 0.05
MEDIUM_IMPACT = 0.01
CONFIDENT_CUSTOMERS = 100
EXPIRE_AFTER_MISSED_RUNS = 2
DISMISSED_COOLDOWN = timedelta(days=90)
DONE_COOLDOWN = timedelta(days=30)
REOPEN_GROWTH = 1.5
"""A dismissed (or done) recommendation comes back early if revenue at stake grows ≥ 50%."""


def build_context(
    metrics: pd.DataFrame,
    purchases: pd.DataFrame,
    customers: pd.DataFrame,
    as_of: date,
    settings: AnalyticsSettings,
) -> RuleContext:
    """Joins the per-customer snapshot with purchase days, consent and trailing revenue."""
    p = purchases[purchases["day"] <= ts(as_of)]
    since = ts(as_of) - pd.Timedelta(days=TRAILING_DAYS)
    trailing = p[p["day"] > since]
    identified = p[p["customer_id"].notna()]
    frame = metrics.copy()
    days = identified.groupby("customer_id")["day"].nunique()
    value = trailing[trailing["customer_id"].notna()].groupby("customer_id")["net"].sum()
    frame["purchase_days"] = frame["customer_id"].map(days).fillna(0).astype("int64")
    frame["value_12m"] = frame["customer_id"].map(value).fillna(0).astype("int64")
    consent = (
        customers.set_index("customer_id")["marketing_consent"]
        if "marketing_consent" in customers
        else pd.Series(dtype=bool)
    )
    frame["marketing_consent"] = frame["customer_id"].map(consent).fillna(False).astype(bool)
    for column in ("f_score", "m_score", "segment_key"):
        if column not in frame:
            frame[column] = None
    return RuleContext(
        as_of=as_of,
        customers=frame,
        purchases=p,
        trailing_revenue=int(trailing["net"].sum()),
        settings=settings,
    )


def prioritise(finding: Finding, trailing_revenue: int) -> Finding:
    """impact = revenue at stake ÷ trailing-12-month revenue; priority_score = impact ×
    min(1, affected / 100)."""
    stake = finding.revenue_at_stake or 0
    impact = stake / trailing_revenue if trailing_revenue > 0 else 0.0
    confidence = min(1.0, len(finding.customers) / CONFIDENT_CUSTOMERS)
    if impact >= HIGH_IMPACT or finding.extra_high:
        finding.priority = "HIGH"
    elif impact >= MEDIUM_IMPACT:
        finding.priority = "MEDIUM"
    else:
        finding.priority = "LOW"
    finding.priority_score = round(min(impact * confidence, 9999.0), 4)
    finding.metrics["impact"] = impact
    return finding


def evaluate(ctx: RuleContext) -> tuple[list[Finding], dict[str, str]]:
    """Every rule's finding, prioritised. A failing rule is skipped and reported, so one bug
    cannot block the others or the snapshot."""
    findings: list[Finding] = []
    errors: dict[str, str] = {}
    for spec, rule in RULES:
        try:
            finding = rule(ctx)
        except Exception as exc:
            errors[spec.key] = str(exc)[:200]
            log.warning("recommendation rule failed", rule=spec.key, error=str(exc))
            continue
        if finding is not None:
            findings.append(prioritise(finding, ctx.trailing_revenue))
    return findings, errors


# ───────────── lifecycle ─────────────


@dataclass(frozen=True)
class Stored:
    id: UUID
    fingerprint: str
    status: str
    status_changed_at: datetime | None
    status_revenue_cents: int | None
    missed_runs: int


@dataclass
class Plan:
    inserts: list[Finding] = field(default_factory=list)
    updates: list[tuple[UUID, Finding, bool]] = field(default_factory=list)
    """(id, finding, reopen): reopen resets the status to OPEN."""
    missed: list[UUID] = field(default_factory=list)
    expired: list[UUID] = field(default_factory=list)


def _cooled_down(row: Stored, finding: Finding, now: datetime, cooldown: timedelta) -> bool:
    if row.status_changed_at is None or now - row.status_changed_at >= cooldown:
        return True
    before = row.status_revenue_cents
    after = finding.revenue_at_stake or 0
    return before is not None and before > 0 and after >= REOPEN_GROWTH * before


def reconcile(existing: list[Stored], findings: list[Finding], now: datetime) -> Plan:
    """One recommendation per fingerprint. Open and acknowledged ones are refreshed; done,
    dismissed and expired ones reopen only when their cooldown allows; open ones the rules no
    longer find expire after two consecutive runs."""
    plan = Plan()
    by_fingerprint = {row.fingerprint: row for row in existing}
    found = set()
    for finding in findings:
        found.add(finding.fingerprint)
        row = by_fingerprint.get(finding.fingerprint)
        if row is None:
            plan.inserts.append(finding)
        elif row.status in ("OPEN", "ACKNOWLEDGED"):
            plan.updates.append((row.id, finding, False))
        elif row.status == "EXPIRED":
            plan.updates.append((row.id, finding, True))
        elif row.status == "DISMISSED":
            reopen = _cooled_down(row, finding, now, DISMISSED_COOLDOWN)
            plan.updates.append((row.id, finding, reopen))
        else:  # DONE
            reopen = _cooled_down(row, finding, now, DONE_COOLDOWN)
            plan.updates.append((row.id, finding, reopen))
    for row in existing:
        if row.fingerprint in found or row.status not in ("OPEN", "ACKNOWLEDGED"):
            continue
        if row.missed_runs + 1 >= EXPIRE_AFTER_MISSED_RUNS:
            plan.expired.append(row.id)
        else:
            plan.missed.append(row.id)
    return plan


# ───────────── persistence ─────────────

INSERT_SQL = """
INSERT INTO recommendations (id, organization_id, run_id, rule_key, rule_version, fingerprint,
  priority, priority_score, status, title, opportunity, explanation, suggested_action, metrics,
  affected_customers, revenue_at_stake_cents, first_detected_at, last_detected_at)
VALUES (%s, %s, %s, %s, %s, %s, %s::"Priority", %s, 'OPEN', %s, %s, %s, %s, %s, %s, %s, %s, %s)
"""

UPDATE_SQL = """
UPDATE recommendations SET run_id = %s, rule_version = %s, priority = %s::"Priority",
  priority_score = %s, title = %s, opportunity = %s, explanation = %s, suggested_action = %s,
  metrics = %s, affected_customers = %s, revenue_at_stake_cents = %s, last_detected_at = %s,
  missed_runs = 0
WHERE id = %s
"""

REOPEN_SQL = """
UPDATE recommendations SET status = 'OPEN', first_detected_at = %s, dismiss_reason = NULL,
  status_revenue_cents = NULL, status_changed_by_id = NULL, status_changed_at = NULL
WHERE id = %s
"""


def _fields(f: Finding) -> tuple[Any, ...]:
    return (
        f.priority, f.priority_score, f.title, f.opportunity, f.explanation,
        f.suggested_action, Jsonb(f.metrics), len(f.customers), f.revenue_at_stake,
    )  # fmt: skip


def _replace_customers(
    conn: psycopg.Connection, org: UUID, recommendation: UUID, customers: pd.Series
) -> None:
    conn.execute(
        "DELETE FROM recommendation_customers WHERE recommendation_id = %s", (recommendation,)
    )
    rows = [(recommendation, customer, org, int(value)) for customer, value in customers.items()]
    with conn.cursor() as cur:
        for start in range(0, len(rows), 1000):
            cur.executemany(
                "INSERT INTO recommendation_customers (recommendation_id, customer_id,"
                " organization_id, value_cents) VALUES (%s, %s, %s, %s)",
                rows[start : start + 1000],
            )


def save(
    conn: psycopg.Connection,
    org: UUID,
    run_id: UUID,
    findings: list[Finding],
    now: datetime,
) -> dict[str, int]:
    """Applies the reconcile plan. `conn` must be inside the run's tenant transaction."""
    rows = conn.execute(
        "SELECT id, fingerprint, status::text, status_changed_at, status_revenue_cents,"
        " missed_runs FROM recommendations WHERE organization_id = %s",
        (org,),
    ).fetchall()
    existing = [
        Stored(r[0], r[1], r[2], r[3], None if r[4] is None else int(r[4]), int(r[5])) for r in rows
    ]
    plan = reconcile(existing, findings, now)
    for finding in plan.inserts:
        rec_id = uuid7()
        conn.execute(
            INSERT_SQL,
            (rec_id, org, run_id, finding.rule_key, finding.rule_version, finding.fingerprint,
             finding.priority, finding.priority_score, finding.title, finding.opportunity,
             finding.explanation, finding.suggested_action, Jsonb(finding.metrics),
             len(finding.customers), finding.revenue_at_stake, now, now),
        )  # fmt: skip
        _replace_customers(conn, org, rec_id, finding.customers)
    reopened = 0
    for rec_id, finding, reopen in plan.updates:
        fields = _fields(finding)
        conn.execute(UPDATE_SQL, (run_id, finding.rule_version, *fields, now, rec_id))
        if reopen:
            conn.execute(REOPEN_SQL, (now, rec_id))
            reopened += 1
        _replace_customers(conn, org, rec_id, finding.customers)
    if plan.missed:
        conn.execute(
            "UPDATE recommendations SET missed_runs = missed_runs + 1 WHERE id = ANY(%s)",
            (plan.missed,),
        )
    if plan.expired:
        conn.execute(
            "UPDATE recommendations SET status = 'EXPIRED', status_changed_at = %s,"
            " missed_runs = missed_runs + 1 WHERE id = ANY(%s)",
            (now, plan.expired),
        )
    return {
        "new": len(plan.inserts),
        "updated": len(plan.updates) - reopened,
        "reopened": reopened,
        "expired": len(plan.expired),
    }
