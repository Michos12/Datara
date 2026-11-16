"""Job handler registry. Handlers are pure orchestration: load data, call metric functions,
persist snapshots. The `analytics.recompute` handler is added in M3."""

from collections.abc import Callable, Mapping

from insights.db import Database
from insights.worker.queue import Job

ANALYTICS_JOB_PREFIXES = ["analytics."]

JobHandler = Callable[[Job, Database], None]

HANDLERS: dict[str, JobHandler] = {}


class UnknownJobTypeError(Exception):
    pass


def dispatch(job: Job, db: Database, handlers: Mapping[str, JobHandler] = HANDLERS) -> None:
    handler = handlers.get(job.type)
    if handler is None:
        raise UnknownJobTypeError(f'No handler registered for job type "{job.type}"')
    handler(job, db)
