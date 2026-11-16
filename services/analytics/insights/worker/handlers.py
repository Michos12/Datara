"""Job handler registry. Handlers orchestrate: load inputs, call pure functions, persist results."""

from collections.abc import Callable, Mapping
from datetime import UTC, datetime

from insights.datagen import GeneratorConfig, generate
from insights.datagen.loader import load
from insights.db import Database
from insights.logging import get_logger
from insights.worker.queue import Job
from insights.worker.recompute import RECOMPUTE_JOB, recompute, schedule_recompute

ANALYTICS_JOB_PREFIXES = ["analytics."]

JobHandler = Callable[[Job, Database], None]

log = get_logger("insights.worker.handlers")


class UnknownJobTypeError(Exception):
    pass


def demo_data(job: Job, db: Database) -> None:
    """Fills an empty organization with synthetic customers and orders (PLT-03)."""
    if job.organization_id is None:
        raise ValueError("demo_data job needs an organization")
    with db.tenant_transaction(job.organization_id) as conn:
        row = conn.execute(
            "SELECT timezone, currency, industry FROM organizations WHERE id = %s",
            (job.organization_id,),
        ).fetchone()
    if row is None:
        raise ValueError("Organization not found")
    timezone, currency, industry = row

    customers = int(job.payload.get("customers", 2000))
    seed = int(job.payload.get("seed", 42))
    data = generate(
        GeneratorConfig(
            customers=min(max(customers, 10), 20000),
            industry=str(industry),
            currency=str(currency).strip(),
            timezone=str(timezone),
            seed=seed,
        )
    )
    with db.tenant_transaction(job.organization_id) as conn:
        counts = load(conn, job.organization_id, data)
        schedule_recompute(conn, job.organization_id, datetime.now(UTC), "demo_data")
    log.info("demo data loaded", organization_id=str(job.organization_id), **counts)


HANDLERS: dict[str, JobHandler] = {
    "analytics.demo_data": demo_data,
    RECOMPUTE_JOB: recompute,
}


def dispatch(job: Job, db: Database, handlers: Mapping[str, JobHandler] = HANDLERS) -> None:
    handler = handlers.get(job.type)
    if handler is None:
        raise UnknownJobTypeError(f'No handler registered for job type "{job.type}"')
    handler(job, db)
