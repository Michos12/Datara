"""On-demand analytics queries for the internal API.

Loaded organization frames are cached in memory by (organization, data_version): a data change
increments the version, so a stale frame is never reused, and repeated queries with different
date ranges reuse one load.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import replace
from datetime import date
from threading import Lock
from typing import Any, Protocol
from uuid import UUID

from insights.data.loader import OrgData, load_org
from insights.db import Database
from insights.metrics.behavior_queries import (
    churn_query,
    churned_customers_query,
    cohorts_query,
    retention_query,
)
from insights.metrics.overview import Compare, default_period, overview
from insights.metrics.rfm import SegmentConfig, rfm, rfm_matrix, segment_counts
from insights.metrics.value_queries import (
    clv_query,
    engagement_query,
    frequency_query,
    journey_query,
)
from insights.periods import Grain, Period, today_in
from insights.segments import latest_run_id, segment_assignments, segment_members


class OrgLoader(Protocol):
    def version(self, organization_id: UUID) -> int: ...
    def load(self, organization_id: UUID) -> OrgData: ...
    def members(self, organization_id: UUID, run_id: UUID | None, segment: str) -> set[str]: ...
    def assignments(self, organization_id: UUID, run_id: UUID | None) -> dict[str, str | None]: ...


class DatabaseLoader:
    def __init__(self, db: Database) -> None:
        self.db = db

    def version(self, organization_id: UUID) -> int:
        with self.db.tenant_transaction(organization_id) as conn:
            row = conn.execute(
                "SELECT data_version FROM organizations WHERE id = %s", (organization_id,)
            ).fetchone()
        if row is None:
            raise LookupError("Organization not found")
        return int(row[0])

    def load(self, organization_id: UUID) -> OrgData:
        with self.db.tenant_transaction(organization_id) as conn:
            return load_org(conn, organization_id)

    def members(self, organization_id: UUID, run_id: UUID | None, segment: str) -> set[str]:
        with self.db.tenant_transaction(organization_id) as conn:
            run = run_id or latest_run_id(conn, organization_id)
            if run is None:
                raise LookupError("No analytics snapshot yet: segments are not available")
            return segment_members(conn, organization_id, run, segment)

    def assignments(self, organization_id: UUID, run_id: UUID | None) -> dict[str, str | None]:
        """Customer → segment of a run (the latest when none is given; empty before any run)."""
        with self.db.tenant_transaction(organization_id) as conn:
            run = run_id or latest_run_id(conn, organization_id)
            return {} if run is None else segment_assignments(conn, organization_id, run)


def restrict_to(data: OrgData, customer_ids: set[str]) -> OrgData:
    """The organization's data limited to some customers (guest orders are dropped)."""
    purchases = data.purchases[data.purchases["customer_id"].isin(customer_ids)]
    customers = data.customers[data.customers["customer_id"].isin(customer_ids)]
    interactions = data.interactions[data.interactions["customer_id"].isin(customer_ids)]
    return replace(data, purchases=purchases, customers=customers, interactions=interactions)


def with_filters(
    result: dict[str, Any], segment: str | None, run_id: UUID | None
) -> dict[str, Any]:
    """Record the segment filter in the envelope and warn that it is applied retroactively."""
    result["meta"]["filters"] = {
        "segment": segment,
        "segmentRunId": str(run_id) if run_id else None,
    }
    if segment:
        result["meta"]["warnings"].append(
            {
                "code": "SEGMENT_FILTER",
                "message": "Filtered to customers in this segment as of the latest snapshot "
                "(today's segment, applied to past periods). Guest orders are excluded.",
            }
        )
    return result


class AnalyticsService:
    def __init__(self, loader: OrgLoader, cache_size: int = 8) -> None:
        self.loader = loader
        self.cache_size = cache_size
        self._cache: OrderedDict[tuple[UUID, int], OrgData] = OrderedDict()
        self._lock = Lock()

    def data(self, organization_id: UUID) -> OrgData:
        key = (organization_id, self.loader.version(organization_id))
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
        data = self.loader.load(organization_id)
        with self._lock:
            self._cache[(organization_id, data.data_version)] = data
            while len(self._cache) > self.cache_size:
                self._cache.popitem(last=False)
        return data

    def overview(
        self,
        organization_id: UUID,
        start: date | None,
        end: date | None,
        compare: Compare,
        grain: Grain | None,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]:
        data = self.scoped(organization_id, segment, run_id)
        period = Period(start, end) if start and end else default_period(data.timezone)
        return with_filters(overview(data, period, compare, grain), segment, run_id)

    def scoped(self, organization_id: UUID, segment: str | None, run_id: UUID | None) -> OrgData:
        """The organization's data, limited to a segment's members when one is given."""
        data = self.data(organization_id)
        if segment:
            data = restrict_to(data, self.loader.members(organization_id, run_id, segment))
        return data

    def retention(
        self,
        organization_id: UUID,
        period: Period | None,
        grain: Grain | None,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]:
        data = self.scoped(organization_id, segment, run_id)
        return with_filters(retention_query(data, period, grain), segment, run_id)

    def churn(
        self,
        organization_id: UUID,
        config: dict[str, Any],
        period: Period | None,
        grain: Grain | None,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]:
        data = self.scoped(organization_id, segment, run_id)
        result = churn_query(data, SegmentConfig.from_dict(config), period, grain)
        return with_filters(result, segment, run_id)

    def churned_customers(
        self,
        organization_id: UUID,
        period: Period | None,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]:
        data = self.scoped(organization_id, segment, run_id)
        return with_filters(churned_customers_query(data, period), segment, run_id)

    def cohorts(
        self,
        organization_id: UUID,
        period: Period | None,
        max_periods: int,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]:
        data = self.scoped(organization_id, segment, run_id)
        return with_filters(cohorts_query(data, period, max_periods), segment, run_id)

    def frequency(
        self,
        organization_id: UUID,
        period: Period | None,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]:
        data = self.scoped(organization_id, segment, run_id)
        return with_filters(frequency_query(data, period), segment, run_id)

    def clv(
        self,
        organization_id: UUID,
        period: Period | None,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]:
        data = self.scoped(organization_id, segment, run_id)
        assignments = self.loader.assignments(organization_id, run_id)
        return with_filters(clv_query(data, assignments, period), segment, run_id)

    def journey(
        self,
        organization_id: UUID,
        period: Period | None,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]:
        data = self.scoped(organization_id, segment, run_id)
        return with_filters(journey_query(data, period), segment, run_id)

    def engagement(
        self,
        organization_id: UUID,
        period: Period | None,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]:
        data = self.scoped(organization_id, segment, run_id)
        return with_filters(engagement_query(data, period), segment, run_id)

    def segment_preview(self, organization_id: UUID, config: dict[str, Any]) -> dict[str, Any]:
        """Segment counts a configuration would produce today, without saving anything."""
        data = self.data(organization_id)
        today = today_in(data.timezone)
        segmented = rfm(
            data.purchases,
            data.customers,
            today,
            data.settings.recency_cut_points,
            SegmentConfig.from_dict(config),
        )
        return {
            "asOf": today.isoformat(),
            "counts": segment_counts(segmented),
            "noPurchases": int(segmented["segment_key"].isna().sum()),
            "matrix": rfm_matrix(segmented),
        }
