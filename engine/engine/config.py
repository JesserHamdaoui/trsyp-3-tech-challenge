"""
Central config, env-overridable, loaded from .env at the project root (see
.gitignore -- .env is never committed). database_url defaults to the
project's remote Supabase Postgres instance (ENGINE_DATABASE_URL in .env,
written by the supabase project-creation step); redis_url still points at
the local Dockerized buffer container (Supabase doesn't host Redis, and
the attempt-frame buffer is short-lived/local by design, not shared state
worth paying for a managed service).
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://jess:rehab_engine_dev@localhost:5432/rehab_engine"
    redis_url: str = "redis://localhost:6379/0"

    supabase_url: str = ""
    supabase_publishable_key: str = ""
    # legacy service_role key, not the new sb_secret_* key -- the Supabase
    # CLI (v2.72.8, this project's pin) only ever returns sb_secret_* keys
    # middle-dot-redacted even when piped to a file, so the real value is
    # unobtainable via this CLI version. The legacy service_role JWT prints
    # unredacted and is functionally equivalent for Admin API auth.
    supabase_service_role_key: str = ""

    model_config = SettingsConfigDict(env_prefix="ENGINE_", env_file=".env", extra="ignore")


settings = Settings()
