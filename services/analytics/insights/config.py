"""Service configuration, validated from environment variables at startup."""

import os
from typing import Any, Literal
from urllib.parse import quote, urlsplit, urlunsplit

from pydantic import Field, PostgresDsn, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def derive_database_url(values: dict[str, Any]) -> dict[str, Any]:
    """Platforms like Render provide only the owner's URL: build the runtime role's URL
    (app_user, subject to row-level security) from it, as the API does."""
    lowered = {k.lower(): v for k, v in values.items()}
    if lowered.get("database_url"):
        return values
    direct, user, password = (
        lowered.get("direct_database_url"),
        lowered.get("app_db_user"),
        lowered.get("app_db_password"),
    )
    if not (direct and user and password):
        return values
    parts = urlsplit(str(direct))
    host = parts.hostname or ""
    netloc = f"{quote(str(user), safe='')}:{quote(str(password), safe='')}@{host}"
    if parts.port:
        netloc += f":{parts.port}"
    return {**values, "database_url": urlunsplit(parts._replace(netloc=netloc))}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    @model_validator(mode="before")
    @classmethod
    def _derive(cls, values: Any) -> Any:
        # The owner URL and role variables are not fields, so read them from the environment.
        if not isinstance(values, dict):
            return values
        extra = {
            k: os.environ[k]
            for k in ("DIRECT_DATABASE_URL", "APP_DB_USER", "APP_DB_PASSWORD")
            if k in os.environ
        }
        derived = derive_database_url({**extra, **values})
        return {k: v for k, v in derived.items() if k not in extra}

    app_version: str = "0.0.0"
    # Runtime role (app_user), subject to row-level security. Handlers set app.org_id per job.
    database_url: PostgresDsn
    # Shared secret the API sends in X-Service-Token on internal calls.
    analytics_service_token: str = Field(min_length=16)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_json: bool = True
    worker_poll_seconds: float = Field(default=1.0, gt=0)
    db_pool_max_size: int = Field(default=5, ge=1)
