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


class AnalyticsQueries(Protocol):
    def overview(
        self,
        organization_id: UUID,
        start: date | None,
        end: date | None,
        compare: Literal["previous_period", "previous_year", "none"],
        grain: Literal["day", "week", "month", "quarter"] | None,
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

    @app.post("/internal/query/overview", dependencies=[Depends(require_service_token)])
    def query_overview(query: OverviewQuery) -> dict[str, Any]:
        if analytics is None:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Analytics not configured")
        try:
            return analytics.overview(
                query.organization_id, query.start, query.end, query.compare, query.grain
            )
        except LookupError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc

    return app
