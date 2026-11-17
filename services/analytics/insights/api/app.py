"""Internal HTTP API (docs/04-api-spec.md §2.13). Reachable only on the private network."""

import hmac
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import date, timedelta
from typing import Annotated, Any, Literal, Protocol
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator

from insights.db import HealthProbe
from insights.definitions import DEFINITIONS
from insights.metrics.rfm import SegmentConfig
from insights.periods import Period
from insights.recommendations.rules import RULE_CATALOGUE


class HealthChecks(BaseModel):
    database: Literal["up", "down"]


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    service: Literal["analytics"] = "analytics"
    version: str
    checks: HealthChecks


class OverviewQuery(BaseModel):
    organization_id: UUID = Field(alias="organizationId")
    start: date | None = None
    end: date | None = None
    compare: Literal["previous_period", "previous_year", "none"] = "previous_period"
    grain: Literal["day", "week", "month", "quarter"] | None = None
    segment: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9_]{1,39}$")
    run_id: UUID | None = Field(default=None, alias="runId")

    @model_validator(mode="after")
    def check_range(self) -> "OverviewQuery":
        if (self.start is None) != (self.end is None):
            raise ValueError("Provide both start and end, or neither")
        if self.start and self.end:
            if self.end <= self.start:
                raise ValueError("end must be after start")
            if self.end - self.start > timedelta(days=366 * 5):
                raise ValueError("The period can be at most five years")
        return self


SEGMENT_PATTERN = r"^[a-z][a-z0-9_]{1,39}$"


class BehaviorQuery(BaseModel):
    """Common parameters of the retention, churn and cohort queries."""

    organization_id: UUID = Field(alias="organizationId")
    start: date | None = None
    end: date | None = None
    segment: str | None = Field(default=None, pattern=SEGMENT_PATTERN)
    run_id: UUID | None = Field(default=None, alias="runId")

    @model_validator(mode="after")
    def check_range(self) -> "BehaviorQuery":
        if (self.start is None) != (self.end is None):
            raise ValueError("Provide both start and end, or neither")
        if self.start and self.end:
            if self.end <= self.start:
                raise ValueError("end must be after start")
            if self.end - self.start > timedelta(days=366 * 5):
                raise ValueError("The period can be at most five years")
        return self

    @property
    def period(self) -> Period | None:
        return Period(self.start, self.end) if self.start and self.end else None


class SeriesQuery(BehaviorQuery):
    grain: Literal["week", "month", "quarter"] | None = None


class ChurnQuery(SeriesQuery):
    # Active segment configuration, validated by the API against packages/contracts.
    segment_config: dict[str, Any] = Field(alias="segmentConfig")


class CohortQuery(BehaviorQuery):
    max_periods: int = Field(default=12, ge=1, le=36, alias="maxPeriods")


class SegmentPreviewQuery(BaseModel):
    organization_id: UUID = Field(alias="organizationId")
    # Validated by the API against packages/contracts segmentConfigSchema before forwarding.
    config: dict[str, Any]


class AnalyticsQueries(Protocol):
    def overview(
        self,
        organization_id: UUID,
        start: date | None,
        end: date | None,
        compare: Literal["previous_period", "previous_year", "none"],
        grain: Literal["day", "week", "month", "quarter"] | None,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]: ...

    def segment_preview(self, organization_id: UUID, config: dict[str, Any]) -> dict[str, Any]: ...

    def retention(
        self,
        organization_id: UUID,
        period: Period | None,
        grain: Literal["week", "month", "quarter"] | None,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]: ...

    def churn(
        self,
        organization_id: UUID,
        config: dict[str, Any],
        period: Period | None,
        grain: Literal["week", "month", "quarter"] | None,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]: ...

    def churned_customers(
        self,
        organization_id: UUID,
        period: Period | None,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]: ...

    def cohorts(
        self,
        organization_id: UUID,
        period: Period | None,
        max_periods: int,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]: ...

    def frequency(
        self,
        organization_id: UUID,
        period: Period | None,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]: ...

    def clv(
        self,
        organization_id: UUID,
        period: Period | None,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]: ...

    def journey(
        self,
        organization_id: UUID,
        period: Period | None,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]: ...

    def engagement(
        self,
        organization_id: UUID,
        period: Period | None,
        segment: str | None = None,
        run_id: UUID | None = None,
    ) -> dict[str, Any]: ...


def create_app(
    *,
    version: str,
    service_token: str,
    database: HealthProbe,
    analytics: AnalyticsQueries | None = None,
    on_startup: Callable[[], None] | None = None,
    on_shutdown: Callable[[], None] | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if on_startup:
            on_startup()
        yield
        if on_shutdown:
            on_shutdown()

    app = FastAPI(
        title="Customer Insights analytics (internal)",
        version=version,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
    )

    def require_service_token(
        x_service_token: Annotated[str | None, Header()] = None,
    ) -> None:
        if x_service_token is None or not hmac.compare_digest(x_service_token, service_token):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid service token")

    @app.get("/internal/health", response_model=HealthResponse)
    def health() -> JSONResponse:
        """Liveness plus database reachability. Unauthenticated so container probes can call it."""
        db_up = database.ping()
        body = HealthResponse(
            status="ok" if db_up else "degraded",
            version=version,
            checks=HealthChecks(database="up" if db_up else "down"),
        )
        return JSONResponse(
            body.model_dump(),
            status_code=status.HTTP_200_OK if db_up else status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    @app.get("/internal/definitions", dependencies=[Depends(require_service_token)])
    def definitions() -> dict[str, Any]:
        """Metric registry: key, version, formula and period rule of every metric."""
        return {"data": [d.to_dict() for d in DEFINITIONS]}

    @app.get("/internal/recommendations/rules", dependencies=[Depends(require_service_token)])
    def recommendation_rules() -> dict[str, Any]:
        """Rule catalogue: key, version, trigger, suggested action and thresholds (REC-03)."""
        return {"data": RULE_CATALOGUE}

    @app.post("/internal/query/overview", dependencies=[Depends(require_service_token)])
    def query_overview(query: OverviewQuery) -> dict[str, Any]:
        if analytics is None:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Analytics not configured")
        try:
            return analytics.overview(
                query.organization_id,
                query.start,
                query.end,
                query.compare,
                query.grain,
                query.segment,
                query.run_id,
            )
        except LookupError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc

    def service() -> AnalyticsQueries:
        if analytics is None:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Analytics not configured")
        return analytics

    def answer(compute: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        try:
            return compute()
        except LookupError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc

    @app.post("/internal/query/retention", dependencies=[Depends(require_service_token)])
    def query_retention(query: SeriesQuery) -> dict[str, Any]:
        queries = service()
        return answer(
            lambda: queries.retention(
                query.organization_id, query.period, query.grain, query.segment, query.run_id
            )
        )

    @app.post("/internal/query/churn", dependencies=[Depends(require_service_token)])
    def query_churn(query: ChurnQuery) -> dict[str, Any]:
        queries = service()
        try:
            SegmentConfig.from_dict(query.segment_config)
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "Invalid segment configuration"
            ) from exc
        return answer(
            lambda: queries.churn(
                query.organization_id,
                query.segment_config,
                query.period,
                query.grain,
                query.segment,
                query.run_id,
            )
        )

    @app.post("/internal/query/churn/customers", dependencies=[Depends(require_service_token)])
    def query_churned_customers(query: BehaviorQuery) -> dict[str, Any]:
        queries = service()
        return answer(
            lambda: queries.churned_customers(
                query.organization_id, query.period, query.segment, query.run_id
            )
        )

    @app.post("/internal/query/cohorts", dependencies=[Depends(require_service_token)])
    def query_cohorts(query: CohortQuery) -> dict[str, Any]:
        queries = service()
        return answer(
            lambda: queries.cohorts(
                query.organization_id,
                query.period,
                query.max_periods,
                query.segment,
                query.run_id,
            )
        )

    def value_endpoint(kind: Literal["frequency", "clv", "journey", "engagement"]) -> None:
        def handler(query: BehaviorQuery) -> dict[str, Any]:
            method = getattr(service(), kind)
            return answer(lambda: method(query.organization_id, query.period, query.segment,
                                         query.run_id))  # fmt: skip

        app.post(
            f"/internal/query/{kind}",
            dependencies=[Depends(require_service_token)],
            name=f"query_{kind}",
        )(handler)

    for kind in ("frequency", "clv", "journey", "engagement"):
        value_endpoint(kind)

    @app.post("/internal/segments/preview", dependencies=[Depends(require_service_token)])
    def segments_preview(query: SegmentPreviewQuery) -> dict[str, Any]:
        if analytics is None:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Analytics not configured")
        try:
            return analytics.segment_preview(query.organization_id, query.config)
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "Invalid configuration"
            ) from exc
        except LookupError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc

    return app
