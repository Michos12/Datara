"""Job queue protocol, shared with the Node worker (apps/api/src/infra/job-queue.ts, ADR-0003)."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

STALE_LOCK_MINUTES = 15

CLAIM_SQL = """
UPDATE jobs
SET status = 'RUNNING', locked_at = now(), locked_by = %(worker_id)s, attempts = attempts + 1
WHERE id = (
    SELECT id FROM jobs
    WHERE type LIKE ANY(%(patterns)s::text[])
      AND (
        (status = 'PENDING' AND run_after <= now())
        OR (status = 'RUNNING' AND locked_at < now() - make_interval(mins => %(stale)s))
      )
    ORDER BY run_after
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
RETURNING id, organization_id, type, payload, attempts, max_attempts
"""


@dataclass(frozen=True, slots=True)
class Job:
    id: UUID
    organization_id: UUID | None
    type: str
    payload: dict[str, Any]
    attempts: int
    max_attempts: int


def retry_delay(attempts: int) -> timedelta:
    """Exponential backoff: 30 s, 2 min, 8 min, ... capped at 1 hour (same as the Node worker)."""
    seconds = 30 * 4 ** max(0, attempts - 1)
    return timedelta(seconds=min(seconds, 3600))


def claim_job(conn: psycopg.Connection, worker_id: str, prefixes: list[str]) -> Job | None:
    with conn.transaction(), conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            CLAIM_SQL,
            {
                "worker_id": worker_id,
                "patterns": [f"{p}%" for p in prefixes],
                "stale": STALE_LOCK_MINUTES,
            },
        )
        row = cur.fetchone()
    if row is None:
        return None
    return Job(
        id=row["id"],
        organization_id=row["organization_id"],
        type=row["type"],
        payload=row["payload"] or {},
        attempts=row["attempts"],
        max_attempts=row["max_attempts"],
    )


def complete_job(conn: psycopg.Connection, job_id: UUID) -> None:
    with conn.transaction():
        conn.execute(
            "UPDATE jobs SET status = 'SUCCEEDED', finished_at = now(), locked_at = NULL,"
            " error = NULL WHERE id = %s",
            (job_id,),
        )


def fail_job(conn: psycopg.Connection, job: Job, message: str) -> None:
    with conn.transaction():
        if job.attempts >= job.max_attempts:
            conn.execute(
                "UPDATE jobs SET status = 'FAILED', finished_at = now(), locked_at = NULL,"
                " error = %s WHERE id = %s",
                (message, job.id),
            )
        else:
            conn.execute(
                "UPDATE jobs SET status = 'PENDING', run_after = %s, locked_at = NULL,"
                " locked_by = NULL, error = %s WHERE id = %s",
                (datetime.now(UTC) + retry_delay(job.attempts), message, job.id),
            )
