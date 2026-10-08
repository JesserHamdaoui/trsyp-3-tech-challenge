"""
Central config, env-overridable, loaded from .env at the project root (see
.gitignore -- .env is never committed). database_url defaults to the
project's remote Supabase Postgres instance (ENGINE_DATABASE_URL in .env,
written by the supabase project-creation step).
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://jess:rehab_engine_dev@localhost:5432/rehab_engine"

    supabase_url: str = ""
    supabase_publishable_key: str = ""
    # legacy service_role key, not the new sb_secret_* key -- the Supabase
    # CLI (v2.72.8, this project's pin) only ever returns sb_secret_* keys
    # middle-dot-redacted even when piped to a file, so the real value is
    # unobtainable via this CLI version. The legacy service_role JWT prints
    # unredacted and is functionally equivalent for Admin API auth.
    supabase_service_role_key: str = ""

    # where an invite email's link sends the invitee -- the frontend page
    # that calls supabase.auth.verifyOtp() / exchanges the invite token for
    # a session, then POSTs /auth/complete-profile
    invite_redirect_url: str = "http://localhost:3000/accept-invite"

    # comma-separated browser origins allowed to call the API (the deployed interface URL(s) in production)
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    # patients' rounds are stored slim: only the frame fields the engine's features read (see engine/retention.py).
    # Reference recordings are always kept in full. Turn off to keep every frame.
    trim_patient_frames: bool = True

    model_config = SettingsConfigDict(env_prefix="ENGINE_", env_file=".env", extra="ignore")


settings = Settings()
