"""
Identity now lives in Supabase Auth. There is no self-signup for any role
through the app: an admin invites other admins and physiatrists, and a
physiatrist invites patients. The very first admin account is created
directly against Supabase (CLI/dashboard or a one-off seed script), outside
this API, since nobody exists yet to invite them -- see the engine's
supabase/ setup. /register below is a server-side passthrough to the
Supabase Admin API (creates the auth.users row with email_confirm +
password pre-set, no invite email) kept only for that seeding use and for
tests; it is not wired to any frontend page.

/invite is how every other account gets created: it wraps Supabase
Admin's invite_user_by_email (creates the auth.users row immediately,
unconfirmed, and emails the invitee a sign-in link/code -- no password is
ever set by the inviter) and stashes role/full_name/invited_by in that
user's metadata so /complete-profile can pick them up once the invite is
accepted. Who may invite whom is INVITE_PERMISSIONS below.

/complete-profile is the invite flow's second step: the invitee's browser
calls supabase.auth.verifyOtp() (or lands with a session already attached,
if they clicked the email's link) against the pending auth.users row
/invite created, then calls this endpoint with the resulting access token
to create our Profile row, reading role/full_name/invited_by back out of
the token's user_metadata rather than trusting a request body field -- the
metadata was set server-side at invite time and the token proves the
caller is that exact invited user, so there's nothing additional to
validate. /login passes credentials straight through to Supabase's own
token endpoint and returns its access token unchanged -- we never see or
store the password, Supabase does the verification.
"""

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlmodel import Session, select

from engine.auth.deps import get_current_user, get_verified_token_payload, require_role
from engine.auth.supabase_admin import get_admin_client
from engine.config import settings
from engine.storage.db import get_session
from engine.storage.models import Attempt, Exercise, PatientExercise, PhysiatristPatient, Profile, UserRole

router = APIRouter(prefix="/auth", tags=["auth"])

# which role may invite which -- admin seeds other admins and physiatrists,
# physiatrists bring on their own patients. There is no self-signup for any
# role; the very first admin is created directly in the DB/Supabase (see
# engine's seed step), outside the app, since nobody can invite the first one.
INVITE_PERMISSIONS: dict[UserRole, set[UserRole]] = {
    UserRole.admin: {UserRole.admin, UserRole.physiatrist},
    UserRole.physiatrist: {UserRole.patient},
}


class InviteIn(BaseModel):
    email: EmailStr
    role: UserRole
    full_name: str = ""


class InviteOut(BaseModel):
    email: str
    role: UserRole
    invited_by: str


class UserOut(BaseModel):
    id: str
    email: str
    role: UserRole
    full_name: str


def _pending_invite(admin, email: str) -> Optional[str]:
    """Supabase user id of an invite that was sent but never accepted, if any."""
    res = admin.auth.admin.list_users(page=1, per_page=1000)
    users = res if isinstance(res, list) else getattr(res, "users", res)
    for u in users:
        if (u.email or "").lower() == email.lower() and not u.email_confirmed_at:
            return str(u.id)
    return None


@router.post("/invite", response_model=InviteOut)
def invite(
    payload: InviteIn,
    current_user: Profile = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    allowed_roles = INVITE_PERMISSIONS.get(current_user.role, set())
    if payload.role not in allowed_roles:
        raise HTTPException(
            status_code=403,
            detail=f"role '{current_user.role.value}' cannot invite role '{payload.role.value}'",
        )

    existing = session.exec(select(Profile).where(Profile.email == payload.email)).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"email '{payload.email}' already registered")

    admin = get_admin_client()
    options = {
        "data": {
            "role": payload.role.value,
            "full_name": payload.full_name,
            "invited_by": str(current_user.id),
        },
        "redirect_to": settings.invite_redirect_url,
    }

    def send():
        admin.auth.admin.invite_user_by_email(payload.email, options)

    try:
        send()
    except Exception as e:
        if "already been registered" not in str(e):
            raise HTTPException(status_code=400, detail=f"supabase invite failed: {e}")
        # An invite that was never accepted leaves an unconfirmed auth user (and no Profile,
        # checked above). Replace it so the invite can be sent again with a fresh code.
        pending = _pending_invite(admin, payload.email)
        if not pending:
            raise HTTPException(status_code=409, detail=f"email '{payload.email}' already registered")
        try:
            admin.auth.admin.delete_user(pending)
            send()
        except Exception as e2:
            raise HTTPException(status_code=400, detail=f"supabase invite failed: {e2}")

    return InviteOut(email=payload.email, role=payload.role, invited_by=str(current_user.id))


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

    invited_by = user_metadata.get("invited_by")
    if role == UserRole.patient and invited_by:
        try:
            physiatrist_id = uuid.UUID(invited_by)
        except ValueError:
            physiatrist_id = None
        if physiatrist_id and session.get(Profile, physiatrist_id):
            session.add(PhysiatristPatient(physiatrist_id=physiatrist_id, patient_id=user_id))

    session.commit()
    session.refresh(profile)
    return UserOut(id=str(profile.id), email=profile.email, role=profile.role, full_name=profile.full_name)


class TeamMember(BaseModel):
    id: str
    email: str
    full_name: str
    role: UserRole
    status: str  # "active" | "pending" (invited, hasn't accepted yet)
    invited_at: Optional[datetime] = None


TEAM_ROLES = {UserRole.admin, UserRole.physiatrist}


@router.get("/team", response_model=list[TeamMember])
def list_team(
    role: UserRole,
    _admin: Profile = Depends(require_role(UserRole.admin)),
    session: Session = Depends(get_session),
):
    """Active members of one staff role, plus invites that haven't been
    accepted yet. Pending invites only exist in Supabase Auth (the Profile row
    is created on acceptance), so they're read from its admin API."""
    if role not in TEAM_ROLES:
        raise HTTPException(status_code=400, detail="role must be 'admin' or 'physiatrist'")

    profiles = session.exec(select(Profile).where(Profile.role == role).order_by(Profile.created_at)).all()
    members = [
        TeamMember(id=str(p.id), email=p.email, full_name=p.full_name, role=p.role, status="active")
        for p in profiles
    ]
    known_ids = {m.id for m in members}

    try:
        auth_users = get_admin_client().auth.admin.list_users(page=1, per_page=1000)
    except Exception:
        return members  # Supabase unreachable: still show the active members
    for u in auth_users:
        meta = u.user_metadata or {}
        if str(u.id) in known_ids or meta.get("role") != role.value:
            continue
        if session.get(Profile, uuid.UUID(str(u.id))):
            continue
        members.append(
            TeamMember(
                id=str(u.id),
                email=u.email or "",
                full_name=meta.get("full_name", "") or "",
                role=role,
                status="pending",
                invited_at=u.invited_at or u.created_at,
            )
        )
    return members


class DeleteOut(BaseModel):
    deleted: str


@router.delete("/team/{user_id}", response_model=DeleteOut)
def remove_team_member(
    user_id: uuid.UUID,
    current_user: Profile = Depends(require_role(UserRole.admin)),
    session: Session = Depends(get_session),
):
    """Revokes a pending invite, or removes an active admin/physiatrist.
    Refuses to remove yourself, the last admin, or a physiatrist who still has
    patients or prescriptions (those rows would be orphaned)."""
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="you can't remove your own account")

    admin = get_admin_client()
    profile = session.get(Profile, user_id)
    if profile:
        if profile.role not in TEAM_ROLES:
            raise HTTPException(status_code=400, detail="only admins and physiatrists can be removed here")
        if profile.role == UserRole.admin:
            admins = session.exec(select(Profile).where(Profile.role == UserRole.admin)).all()
            if len(admins) <= 1:
                raise HTTPException(status_code=409, detail="can't remove the last admin")
        if profile.role == UserRole.physiatrist:
            has_patients = session.exec(
                select(PhysiatristPatient).where(PhysiatristPatient.physiatrist_id == user_id)
            ).first()
            has_rx = session.exec(select(PatientExercise).where(PatientExercise.prescribed_by_id == user_id)).first()
            if has_patients or has_rx:
                raise HTTPException(
                    status_code=409, detail="this physiatrist still has patients or prescriptions on record"
                )
        session.delete(profile)
        session.commit()
    else:
        try:
            auth_user = admin.auth.admin.get_user_by_id(str(user_id)).user
        except Exception:
            raise HTTPException(status_code=404, detail="user not found")
        if (auth_user.user_metadata or {}).get("role") not in {r.value for r in TEAM_ROLES}:
            raise HTTPException(status_code=400, detail="only pending admin/physiatrist invites can be revoked here")

    try:
        admin.auth.admin.delete_user(str(user_id))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"supabase delete failed: {e}")
    return DeleteOut(deleted=str(user_id))


class PatientRef(BaseModel):
    id: str
    name: str


class PatientOut(BaseModel):
    id: str
    email: str
    full_name: str
    joined_at: datetime
    # access (from Supabase Auth; None if it couldn't be reached)
    last_sign_in_at: Optional[datetime] = None
    suspended: bool = False
    # care relationships
    physiatrists: list[PatientRef]
    prescribed_exercises: list[str]
    # activity (from attempts)
    rounds: int
    last_round_at: Optional[datetime]
    active_days_30: int
    avg_accuracy: Optional[float]


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


@router.get("/patients", response_model=list[PatientOut])
def list_patients(
    _admin: Profile = Depends(require_role(UserRole.admin)),
    session: Session = Depends(get_session),
):
    """Every patient with access info (Supabase Auth) and activity derived from
    their attempts. There is no page-view tracking: 'activity' means rounds
    played, 'access' means sign-in history and whether the account is suspended."""
    patients = session.exec(select(Profile).where(Profile.role == UserRole.patient).order_by(Profile.created_at.desc())).all()
    profiles = {p.id: p for p in session.exec(select(Profile)).all()}
    names = {i: (p.full_name or p.email) for i, p in profiles.items()}
    exercises = {e.exercise_id: e.display_name for e in session.exec(select(Exercise)).all()}

    links: dict[uuid.UUID, list[uuid.UUID]] = {}
    for a in session.exec(select(PhysiatristPatient)).all():
        links.setdefault(a.patient_id, []).append(a.physiatrist_id)
    rx: dict[uuid.UUID, list[str]] = {}
    for r in session.exec(select(PatientExercise)).all():
        rx.setdefault(r.patient_id, []).append(exercises.get(r.exercise_id, r.exercise_id))

    attempts: dict[uuid.UUID, list] = {}
    for row in session.exec(
        select(Attempt.patient_id, Attempt.created_at, Attempt.meta).where(Attempt.is_idealized == False)  # noqa: E712
    ).all():
        if row.patient_id is not None:
            attempts.setdefault(row.patient_id, []).append(row)

    auth_info: dict[str, object] = {}
    try:
        for u in get_admin_client().auth.admin.list_users(page=1, per_page=1000):
            auth_info[str(u.id)] = u
    except Exception:
        pass  # access info is best-effort

    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    out = []
    for p in patients:
        rows = attempts.get(p.id, [])
        accs = []
        for r in rows:
            h, l, m = (r.meta.get(k) for k in ("hits", "leaks", "misses"))
            if all(isinstance(v, int) for v in (h, l, m)) and h + l + m:
                accs.append(h / (h + l + m))
        u = auth_info.get(str(p.id))
        banned_until = getattr(u, "banned_until", None) if u else None
        out.append(
            PatientOut(
                id=str(p.id),
                email=p.email,
                full_name=p.full_name,
                joined_at=p.created_at,
                last_sign_in_at=getattr(u, "last_sign_in_at", None) if u else None,
                suspended=bool(banned_until and _aware(banned_until) > datetime.now(timezone.utc)),
                physiatrists=[PatientRef(id=str(i), name=names.get(i, "Unknown")) for i in links.get(p.id, [])],
                prescribed_exercises=sorted(rx.get(p.id, [])),
                rounds=len(rows),
                last_round_at=max((r.created_at for r in rows), default=None),
                active_days_30=len({_aware(r.created_at).date() for r in rows if _aware(r.created_at) >= cutoff}),
                avg_accuracy=round(sum(accs) / len(accs), 3) if accs else None,
            )
        )
    return out


class AccessIn(BaseModel):
    suspended: bool


@router.post("/patients/{patient_id}/access", response_model=PatientRef)
def set_patient_access(
    patient_id: uuid.UUID,
    payload: AccessIn,
    _admin: Profile = Depends(require_role(UserRole.admin)),
    session: Session = Depends(get_session),
):
    """Suspend or restore a patient's ability to sign in (Supabase ban). Data is
    kept either way. Already-issued access tokens stay valid until they expire."""
    patient = session.get(Profile, patient_id)
    if not patient or patient.role != UserRole.patient:
        raise HTTPException(status_code=404, detail="patient not found")
    try:
        get_admin_client().auth.admin.update_user_by_id(
            str(patient_id), {"ban_duration": "876000h" if payload.suspended else "none"}
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"supabase update failed: {e}")
    return PatientRef(id=str(patient.id), name=patient.full_name or patient.email)


@router.get("/me", response_model=UserOut)
def me(current_user: Profile = Depends(get_current_user)):
    return UserOut(
        id=str(current_user.id),
        email=current_user.email,
        role=current_user.role,
        full_name=current_user.full_name,
    )


class UpdateMeIn(BaseModel):
    full_name: str = Field(min_length=1, max_length=80)


@router.patch("/me", response_model=UserOut)
def update_me(
    payload: UpdateMeIn,
    current_user: Profile = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Lets any user set their own display name."""
    current_user.full_name = payload.full_name.strip()
    session.add(current_user)
    session.commit()
    session.refresh(current_user)
    return UserOut(
        id=str(current_user.id),
        email=current_user.email,
        role=current_user.role,
        full_name=current_user.full_name,
    )
