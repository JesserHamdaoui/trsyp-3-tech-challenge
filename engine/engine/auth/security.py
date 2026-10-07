"""
Verifies Supabase-issued JWTs. We no longer mint our own tokens -- signup
and login happen client-side via the Supabase SDK (or server-side via the
Admin API for the /auth/register passthrough, see engine/api/auth.py), and
every request to this backend carries the resulting Supabase access token.

Supabase signs with ES256 (asymmetric) and publishes the public key at a
JWKS endpoint, so verification needs no shared secret -- PyJWKClient fetches
and caches the signing key, refreshing automatically if Supabase rotates it.
"""

import jwt
from jwt import PyJWKClient

from engine.config import settings

ALGORITHM = "ES256"

_jwks_client = PyJWKClient(f"{settings.supabase_url}/auth/v1/.well-known/jwks.json")


def decode_access_token(token: str) -> dict:
    signing_key = _jwks_client.get_signing_key_from_jwt(token)
    return jwt.decode(
        token,
        signing_key.key,
        algorithms=[ALGORITHM],
        audience="authenticated",
    )
