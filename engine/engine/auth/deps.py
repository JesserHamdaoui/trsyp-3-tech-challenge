"""
FastAPI dependencies for authentication and role gating. The bearer token
is a Supabase-issued access token (minted by the Supabase SDK at
signup/login on the client, or by our /auth/register passthrough during
server-side user creation) -- see engine.auth.security for verification
against Supabase's JWKS. Any endpoint that needs a logged-in user takes
`current_user: Profile = Depends(get_current_user)`; one that needs a
specific role uses `Depends(require_role(UserRole.patient))` etc.
Physiatrist<->patient assignment (who may access whose data) is checked
per-endpoint in the relevant router, not here, since what "access" means
differs by resource (attempts, params, dashboards).
"""

import uuid

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlmodel import Session

from engine.auth.security import decode_access_token
from engine.storage.db import get_session
from engine.storage.models import Profile, UserRole

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


def get_verified_token_payload(token: str = Depends(oauth2_scheme)) -> dict:
    """Verifies the Supabase JWT and returns its decoded payload, without
    requiring a matching Profile row to already exist. Only for the one
    endpoint that creates that row in the first place
    (POST /auth/complete-profile) -- everything else should depend on
    get_current_user instead, which also confirms the Profile exists."""
    try:
        return decode_access_token(token)
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )


def get_current_user(
    payload: dict = Depends(get_verified_token_payload),
    session: Session = Depends(get_session),
) -> Profile:
    credentials_error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        user_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError):
        raise credentials_error

    profile = session.get(Profile, user_id)
    if not profile:
        raise credentials_error
    return profile


def require_role(*roles: UserRole):
    def dependency(current_user: Profile = Depends(get_current_user)) -> Profile:
        if current_user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"requires role in {[r.value for r in roles]}, got '{current_user.role.value}'",
            )
        return current_user

    return dependency
