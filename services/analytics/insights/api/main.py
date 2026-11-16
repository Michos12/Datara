"""ASGI entry point: `uvicorn insights.api.main:app`."""

from insights.api.app import create_app
from insights.config import Settings
from insights.db import Database
from insights.logging import configure_logging
from insights.service import AnalyticsService, DatabaseLoader

settings = Settings()  # type: ignore[call-arg]  # values come from the environment
configure_logging(settings.log_level, json=settings.log_json)
database = Database(str(settings.database_url), max_size=settings.db_pool_max_size)

app = create_app(
    version=settings.app_version,
    service_token=settings.analytics_service_token,
    database=database,
    analytics=AnalyticsService(DatabaseLoader(database)),
    on_startup=database.open,
    on_shutdown=database.close,
)
