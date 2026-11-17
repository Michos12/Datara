"""Segment configuration and membership lookups (database side of RFM segmentation)."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

import psycopg

from insights.metrics.rfm import SegmentConfig

NO_PURCHASES = "no_purchases"


@dataclass(frozen=True, slots=True)
class StoredSegmentConfig:
    id: UUID
    version: int
    config: SegmentConfig


def load_active_segment_config(
    conn: psycopg.Connection, organization_id: UUID
) -> StoredSegmentConfig | None:
    """The organization's active configuration. Every organization gets version 1 at signup
    (or from the M4 migration backfill); None means segmentation is skipped."""
    row = conn.execute(
        "SELECT id, version, config FROM segment_configs WHERE organization_id = %s AND is_active",
        (organization_id,),
    ).fetchone()
    if row is None:
        return None
    return StoredSegmentConfig(
        id=row[0], version=int(row[1]), config=SegmentConfig.from_dict(row[2])
    )


def latest_run_id(conn: psycopg.Connection, organization_id: UUID) -> UUID | None:
    row = conn.execute(
        "SELECT id FROM analytics_runs WHERE organization_id = %s AND status = 'SUCCEEDED'"
        " ORDER BY started_at DESC LIMIT 1",
        (organization_id,),
    ).fetchone()
    return row[0] if row else None


def segment_members(
    conn: psycopg.Connection, organization_id: UUID, run_id: UUID, segment_key: str
) -> set[str]:
    """Customer IDs in a segment as of a run ("no_purchases" = not scored)."""
    if segment_key == NO_PURCHASES:
        sql = (
            "SELECT customer_id::text FROM analytics_customer_metrics"
            " WHERE organization_id = %s AND run_id = %s AND segment_key IS NULL"
        )
        params: tuple[object, ...] = (organization_id, run_id)
    else:
        sql = (
            "SELECT customer_id::text FROM analytics_customer_metrics"
            " WHERE organization_id = %s AND run_id = %s AND segment_key = %s"
        )
        params = (organization_id, run_id, segment_key)
    return {row[0] for row in conn.execute(sql, params).fetchall()}


def segment_assignments(
    conn: psycopg.Connection, organization_id: UUID, run_id: UUID
) -> dict[str, str | None]:
    """Every customer's segment key in a run (None = not scored)."""
    rows = conn.execute(
        "SELECT customer_id::text, segment_key FROM analytics_customer_metrics"
        " WHERE organization_id = %s AND run_id = %s",
        (organization_id, run_id),
    ).fetchall()
    return {row[0]: row[1] for row in rows}
