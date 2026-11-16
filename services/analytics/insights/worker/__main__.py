"""Analytics worker: `python -m insights.worker`. Claims and runs `analytics.*` jobs."""

import os
import signal
import socket
import time
from types import FrameType

import psycopg

from insights.config import Settings
from insights.db import Database
from insights.logging import configure_logging, get_logger
from insights.worker.handlers import ANALYTICS_JOB_PREFIXES, dispatch
from insights.worker.queue import claim_job, complete_job, fail_job

log = get_logger("insights.worker")


def main() -> None:
    settings = Settings()  # type: ignore[call-arg]
    configure_logging(settings.log_level, json=settings.log_json, service="analytics-worker")
    db = Database(str(settings.database_url), max_size=2)
    db.open()
    worker_id = f"py-{socket.gethostname()}-{os.getpid()}"
    running = True

    def stop(_signum: int, _frame: FrameType | None) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log.info("worker started", worker_id=worker_id, prefixes=ANALYTICS_JOB_PREFIXES)

    while running:
        try:
            with db.connection() as conn:
                job = claim_job(conn, worker_id, ANALYTICS_JOB_PREFIXES)
            if job is None:
                time.sleep(settings.worker_poll_seconds)
                continue
            try:
                started = time.perf_counter()
                dispatch(job, db)
                with db.connection() as conn:
                    complete_job(conn, job.id)
                log.info(
                    "job succeeded",
                    job_id=str(job.id),
                    type=job.type,
                    seconds=round(time.perf_counter() - started, 3),
                )
            except Exception as exc:
                log.exception("job failed", job_id=str(job.id), type=job.type)
                with db.connection() as conn:
                    fail_job(conn, job, str(exc))
        except psycopg.Error:
            log.exception("database error; backing off")
            time.sleep(settings.worker_poll_seconds * 5)

    db.close()
    log.info("worker stopped")


if __name__ == "__main__":
    main()
