from datetime import UTC, date, datetime
from uuid import UUID

from fastapi.testclient import TestClient

from insights.api.app import create_app
from insights.data.loader import OrgData
from insights.definitions import BY_KEY, DEFINITIONS
from insights.metrics.overview import KPI_ORDER, default_period, overview
from insights.periods import Period
from insights.service import AnalyticsService
from tests.fixtures import org_data

NOW = datetime(2026, 4, 15, 12, tzinfo=UTC)
MARCH = Period(date(2026, 3, 1), date(2026, 4, 1))


def kpi(result: dict, key: str) -> dict:  # type: ignore[type-arg]
    return next(k for k in result["data"]["kpis"] if k["key"] == key)


def test_overview_kpis_and_comparison() -> None:
    result = overview(org_data(), MARCH, "previous_period", now=NOW)
    revenue = kpi(result, "revenue_net")
    assert revenue["value"] == 1420
    assert revenue["previous"] == 250  # February
    assert revenue["change"] == (1420 - 250) / 250
    assert revenue["changeType"] == "relative"

    retention = kpi(result, "retention_rate")
    assert (retention["value"], retention["numerator"], retention["denominator"]) == (0.5, 1, 2)
    assert retention["changeType"] == "points"
    assert retention["warning"] == "LOW_SAMPLE"
    assert result["meta"]["comparePeriod"] == {"start": "2026-02-01", "end": "2026-03-01"}
    assert any(w["code"] == "LOW_SAMPLE" for w in result["meta"]["warnings"])


def test_overview_meta_documents_period_and_versions() -> None:
    result = overview(org_data(data_version=7), MARCH, now=NOW)
    meta = result["meta"]
    assert meta["asOf"] == "2026-03-31"
    assert meta["timezone"] == "America/Bogota"
    assert meta["dataVersion"] == 7
    assert meta["period"]["grain"] == "day"
    assert set(meta["definitionVersions"]) >= set(KPI_ORDER)
    assert not any(w["code"] == "PARTIAL_PERIOD" for w in meta["warnings"])


def test_partial_period_is_flagged_and_as_of_is_today() -> None:
    april = Period(date(2026, 4, 1), date(2026, 5, 1))
    result = overview(org_data(), april, "none", now=NOW)
    assert result["meta"]["asOf"] == "2026-04-15"
    assert result["meta"]["comparePeriod"] is None
    assert any(w["code"] == "PARTIAL_PERIOD" for w in result["meta"]["warnings"])
    assert result["data"]["trend"][-1]["partial"] is True
    assert kpi(result, "revenue_net")["previous"] is None


def test_default_period_is_last_complete_month() -> None:
    assert default_period("UTC", datetime(2026, 1, 10, tzinfo=UTC)) == Period(
        date(2025, 12, 1), date(2026, 1, 1)
    )


def test_every_kpi_has_a_definition() -> None:
    for key in KPI_ORDER:
        assert BY_KEY[key].version >= 1
        assert BY_KEY[key].formula
    assert len({d.key for d in DEFINITIONS}) == len(DEFINITIONS)


class CountingLoader:
    def __init__(self) -> None:
        self.version_value = 1
        self.loads = 0

    def version(self, organization_id: UUID) -> int:
        return self.version_value

    def load(self, organization_id: UUID) -> OrgData:
        self.loads += 1
        return org_data(self.version_value)

    def members(self, organization_id: UUID, run_id: UUID | None, segment: str) -> set[str]:
        return {"A", "B"} if segment == "loyal" else set()

    def assignments(self, organization_id: UUID, run_id: UUID | None) -> dict[str, str | None]:
        return {"A": "loyal", "B": "loyal", "C": "lost", "D": None}


def test_service_reuses_loaded_data_until_the_version_changes() -> None:
    loader = CountingLoader()
    service = AnalyticsService(loader)
    org = UUID("0193a2b4-0000-7000-8000-000000000001")
    service.overview(org, MARCH.start, MARCH.end, "none", None)
    service.overview(org, date(2026, 1, 1), date(2026, 4, 1), "previous_year", "month")
    assert loader.loads == 1
    loader.version_value = 2
    service.overview(org, MARCH.start, MARCH.end, "none", None)
    assert loader.loads == 2


class FakeDb:
    def ping(self) -> bool:
        return True


TOKEN = "test-service-token-123"


def client() -> TestClient:
    return TestClient(
        create_app(
            version="x",
            service_token=TOKEN,
            database=FakeDb(),
            analytics=AnalyticsService(CountingLoader()),
        )
    )


def test_internal_overview_endpoint() -> None:
    res = client().post(
        "/internal/query/overview",
        headers={"X-Service-Token": TOKEN},
        json={
            "organizationId": "0193a2b4-0000-7000-8000-000000000001",
            "start": "2026-03-01",
            "end": "2026-04-01",
        },
    )
    assert res.status_code == 200
    assert res.json()["meta"]["metric"] == "overview"


def test_internal_overview_validates_input_and_token() -> None:
    c = client()
    assert c.post("/internal/query/overview", json={}).status_code == 401
    bad = c.post(
        "/internal/query/overview",
        headers={"X-Service-Token": TOKEN},
        json={"organizationId": "0193a2b4-0000-7000-8000-000000000001", "start": "2026-03-01"},
    )
    assert bad.status_code == 422
    reversed_range = c.post(
        "/internal/query/overview",
        headers={"X-Service-Token": TOKEN},
        json={
            "organizationId": "0193a2b4-0000-7000-8000-000000000001",
            "start": "2026-04-01",
            "end": "2026-03-01",
        },
    )
    assert reversed_range.status_code == 422


def test_definitions_endpoint_lists_registry() -> None:
    res = client().get("/internal/definitions", headers={"X-Service-Token": TOKEN})
    keys = {d["key"] for d in res.json()["data"]}
    assert {"retention_rate", "churn_rate", "historical_clv"} <= keys


def test_segment_filter_restricts_customers_and_drops_guests() -> None:
    service = AnalyticsService(CountingLoader())
    org = UUID("0193a2b4-0000-7000-8000-000000000001")
    result = service.overview(org, MARCH.start, MARCH.end, "none", None, segment="loyal")
    # Members A and B: March revenue is A's 300 only (guest orders and C excluded).
    assert kpi(result, "revenue_net")["value"] == 300
    assert kpi(result, "total_customers")["value"] == 2
    assert result["meta"]["filters"]["segment"] == "loyal"
    assert any(w["code"] == "SEGMENT_FILTER" for w in result["meta"]["warnings"])


def test_segment_preview_counts() -> None:
    service = AnalyticsService(CountingLoader())
    org = UUID("0193a2b4-0000-7000-8000-000000000001")
    from tests.test_rfm import DEFAULT

    preview = service.segment_preview(org, DEFAULT)
    assert sum(preview["counts"].values()) + preview["noPurchases"] == 6
    assert len(preview["matrix"]) == 5
