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


def test_snapshot_retention_keeps_recent_and_one_per_month() -> None:
    from datetime import UTC, datetime, timedelta
    from uuid import UUID

    from insights.worker.recompute import runs_to_keep

    now = datetime(2026, 11, 18, 3, tzinfo=UTC)
    # One succeeded run per day for 900 days, newest first.
    runs = [(UUID(int=i + 1), "SUCCEEDED", now - timedelta(days=i)) for i in range(900)]
    runs.append((UUID(int=10_000), "FAILED", now - timedelta(hours=2)))
    runs.append((UUID(int=10_001), "FAILED", now - timedelta(days=3)))
    keep = runs_to_keep(runs, now)
    # The 7 latest, plus the last run of each month within 24 months (Nov 2026 counted once).
    assert {UUID(int=i + 1) for i in range(7)} <= keep
    monthly = {r[0] for r in runs if r[1] == "SUCCEEDED"} & keep - {
        UUID(int=i + 1) for i in range(7)
    }
    assert len(monthly) == 24
    assert all(r[2] >= now - timedelta(days=24 * 31) for r in runs if r[0] in monthly)
    assert UUID(int=10_000) in keep  # a recent failure stays visible
    assert UUID(int=10_001) not in keep


def test_runtime_database_url_is_derived_from_the_owner_url() -> None:
    from insights.config import derive_database_url

    values = derive_database_url(
        {
            "DIRECT_DATABASE_URL": "postgresql://owner:secret@db.internal:5432/ci?sslmode=require",
            "APP_DB_USER": "app_user",
            "APP_DB_PASSWORD": "p@ss/word",
        }
    )
    assert values["database_url"] == (
        "postgresql://app_user:p%40ss%2Fword@db.internal:5432/ci?sslmode=require"
    )
    assert derive_database_url({"DATABASE_URL": "x"}) == {"DATABASE_URL": "x"}
