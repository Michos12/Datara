"""Internal HTTP API (docs/04-api-spec.md §2.13). Reachable only on the private network."""

import hmac
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from insights.db import HealthProbe
from insights.definitions import DEFINITIONS, MetricDefinition


class HealthChecks(BaseModel):
    database: Literal["up", "down"]


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    service: Literal["analytics"] = "analytics"
    version: str
    checks: HealthChecks


def create_app(
    *,
    version: str,
    service_token: str,
    database: HealthProbe,
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

    @app.get(
        "/internal/definitions",
        dependencies=[Depends(require_service_token)],
    )
    def definitions() -> dict[str, Any]:
        """Metric registry (populated from M3)."""
        return {"data": [d.to_dict() for d in DEFINITIONS]}

    return app


__all__ = ["MetricDefinition", "create_app"]
