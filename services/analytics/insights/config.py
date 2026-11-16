"""Service configuration, validated from environment variables at startup."""

from typing import Literal

from pydantic import Field, PostgresDsn
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    app_version: str = "0.0.0"
    # Runtime role (app_user), subject to row-level security. Handlers set app.org_id per job.
    database_url: PostgresDsn
    # Shared secret the API sends in X-Service-Token on internal calls.
    analytics_service_token: str = Field(min_length=16)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_json: bool = True
    worker_poll_seconds: float = Field(default=1.0, gt=0)
    db_pool_max_size: int = Field(default=5, ge=1)
