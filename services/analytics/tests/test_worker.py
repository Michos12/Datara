from datetime import timedelta
from typing import cast
from uuid import uuid4

import pytest
from pydantic import ValidationError

from insights.config import Settings
from insights.db import Database
from insights.worker.handlers import UnknownJobTypeError, dispatch
from insights.worker.queue import Job, retry_delay


def make_job(job_type: str = "analytics.recompute") -> Job:
    return Job(
        id=uuid4(),
        organization_id=uuid4(),
        type=job_type,
        payload={},
        attempts=1,
        max_attempts=3,
    )


@pytest.mark.parametrize(
    ("attempts", "expected"),
    [(1, 30), (2, 120), (3, 480), (20, 3600)],
)
def test_retry_delay_matches_node_worker(attempts: int, expected: int) -> None:
    assert retry_delay(attempts) == timedelta(seconds=expected)


def test_dispatch_calls_registered_handler() -> None:
    seen: list[Job] = []
    job = make_job()
    dispatch(job, cast(Database, None), {"analytics.recompute": lambda j, _db: seen.append(j)})
    assert seen == [job]


def test_dispatch_rejects_unknown_job_type() -> None:
    with pytest.raises(UnknownJobTypeError):
        dispatch(make_job("analytics.unknown"), cast(Database, None), {})


def test_settings_validate_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://app_user:pw@db:5432/customer_insights")
    monkeypatch.setenv("ANALYTICS_SERVICE_TOKEN", "a-sufficiently-long-token")
    settings = Settings()  # type: ignore[call-arg]
    assert settings.database_url.scheme == "postgresql"
    assert settings.log_level == "INFO"


def test_settings_reject_short_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://app_user:pw@db:5432/customer_insights")
    monkeypatch.setenv("ANALYTICS_SERVICE_TOKEN", "short")
    with pytest.raises(ValidationError):
        Settings()  # type: ignore[call-arg]
