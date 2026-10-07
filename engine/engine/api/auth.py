"""
Identity now lives in Supabase Auth. /register is a server-side passthrough
to the Supabase Admin API (creates the auth.users row with email_confirm
pre-set, since there's no email flow wired up yet) plus our own Profile
row in the same request -- used for admin-created accounts (e.g. a
physiatrist registering a patient server-side), not the primary signup
path. /login passes credentials straight through to Supabase's own token
endpoint and returns its access token unchanged -- we never see or store
the password, Supabase does the verification.

/complete-profile is the primary signup path's second step: the Next.js
interface calls supabase.auth.signUp() directly (client-side, with
role/full_name passed as signup metadata), which creates the auth.users
row but not our Profile row. The frontend then calls this endpoint with
the resulting access token to create that row, reading role/full_name back
out of the token's user_metadata rather than trusting a request body field
-- the metadata was already set at signUp() time and the token proves the
caller is that exact user, so there's nothing additional to validate.
"""

import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr
from sqlmodel import Session, select

from engine.auth.deps import get_current_user, get_verified_token_payload
from engine.auth.supabase_admin import get_admin_client
from engine.config import settings
from engine.storage.db import get_session
from engine.storage.models import Profile, UserRole

router = APIRouter(prefix="/auth", tags=["auth"])


class RegisterIn(BaseModel):
    email: EmailStr
    password: str
    role: UserRole
    full_name: str = ""


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: UserRole
    user_id: str


class UserOut(BaseModel):
    id: str
    email: str
    role: UserRole
    full_name: str


@router.post("/register", response_model=UserOut)
def register(payload: RegisterIn, session: Session = Depends(get_session)):
    existing = session.exec(select(Profile).where(Profile.email == payload.email)).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"email '{payload.email}' already registered")

    admin = get_admin_client()
    try:
        auth_resp = admin.auth.admin.create_user({
            "email": payload.email,
            "password": payload.password,
            "email_confirm": True,
        })
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"supabase user creation failed: {e}")

    profile = Profile(
        id=auth_resp.user.id,
        email=payload.email,
        role=payload.role,
        full_name=payload.full_name,
    )
    session.add(profile)
    session.commit()
    session.refresh(profile)
    return UserOut(id=str(profile.id), email=profile.email, role=profile.role, full_name=profile.full_name)


@router.post("/login", response_model=TokenOut)
def login(form_data: OAuth2PasswordRequestForm = Depends(), session: Session = Depends(get_session)):
    resp = httpx.post(
        f"{settings.supabase_url}/auth/v1/token?grant_type=password",
        headers={"apikey": settings.supabase_publishable_key, "Content-Type": "application/json"},
        json={"email": form_data.username, "password": form_data.password},
    )
    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="incorrect email or password")

    body = resp.json()
    user_id = body["user"]["id"]

    profile = session.get(Profile, user_id)
    if not profile:
        raise HTTPException(status_code=500, detail="authenticated with Supabase but no matching profile exists")

    return TokenOut(access_token=body["access_token"], role=profile.role, user_id=user_id)


@router.post("/complete-profile", response_model=UserOut)
def complete_profile(
    payload: dict = Depends(get_verified_token_payload),
    session: Session = Depends(get_session),
):
    user_id = uuid.UUID(payload["sub"])
    email = payload.get("email")
    user_metadata = payload.get("user_metadata", {})
    role = user_metadata.get("role")
    full_name = user_metadata.get("full_name", "")

    if not role:
        raise HTTPException(
            status_code=400,
            detail="token has no 'role' in user_metadata; pass role in signUp() options.data",
        )
    try:
        role = UserRole(role)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"invalid role '{role}'")

    existing = session.get(Profile, user_id)
    if existing:
        raise HTTPException(status_code=409, detail="profile already exists for this user")

    profile = Profile(id=user_id, email=email, role=role, full_name=full_name)
    session.add(profile)
    session.commit()
    session.refresh(profile)
    return UserOut(id=str(profile.id), email=profile.email, role=profile.role, full_name=profile.full_name)


@router.get("/me", response_model=UserOut)
def me(current_user: Profile = Depends(get_current_user)):
    return UserOut(
        id=str(current_user.id),
        email=current_user.email,
        role=current_user.role,
        full_name=current_user.full_name,
    )
