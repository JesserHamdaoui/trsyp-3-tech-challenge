"""
Supabase Admin API client, service-role key (bypasses RLS, can create
users directly) -- used only by engine.api.auth's /auth/register
passthrough, since there's no frontend yet to call the Supabase SDK's
signUp() directly. Once a frontend exists for a given role, that role
should sign up via the SDK instead; this stays as a server-side path for
admin-created accounts (e.g. a physiatrist registering a patient) and for
testing.
"""

from supabase import Client, create_client

from engine.config import settings

_admin_client: Client | None = None


def get_admin_client() -> Client:
    global _admin_client
    if _admin_client is None:
        _admin_client = create_client(settings.supabase_url, settings.supabase_service_role_key)
    return _admin_client
