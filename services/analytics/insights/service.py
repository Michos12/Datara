"""On-demand analytics queries for the internal API.

Loaded organization frames are cached in memory by (organization, data_version): a data change
increments the version, so a stale frame is never reused, and repeated queries with different
date ranges reuse one load.
"""

from __future__ import annotations

from collections import OrderedDict
from datetime import date
from threading import Lock
from typing import Any, Protocol
from uuid import UUID

from insights.data.loader import OrgData, load_org
from insights.db import Database
from insights.metrics.overview import Compare, default_period, overview
from insights.periods import Grain, Period


class OrgLoader(Protocol):
    def version(self, organization_id: UUID) -> int: ...
    def load(self, organization_id: UUID) -> OrgData: ...


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
    ) -> dict[str, Any]:
        data = self.data(organization_id)
        period = Period(start, end) if start and end else default_period(data.timezone)
        return overview(data, period, compare, grain)
