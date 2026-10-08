"""
Attempts, auth-gated.

POST /attempts/batch takes a whole attempt (all frames) in one request: the games record in the browser and
submit once when the round ends. A patient must be prescribed the exercise. An admin (demonstrator role) may
also submit is_idealized=true attempts that seed an exercise's reference; admins skip the prescription check
and their attempts are stored with patient_id left null, since the attempt isn't tied to any patient's care.

A patient acts only as themselves (patient_id is taken from the token, never trusted from the client) and only
for an exercise they've been prescribed (PatientExercise). A physiatrist may only read attempts of a patient
assigned to them (PhysiatristPatient). Features are extracted on write (engine/games.py picks the extractor).
"""

import uuid
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from engine.analysis import AnalysisOut, analyze, analyze_attempt, next_params_for
from engine.config import settings
from engine.games import spec_for
from engine.retention import slim_frames
from engine.auth.deps import get_current_user, require_role
from engine.quality import QualityReport, analyze
from engine.storage.db import get_session
from engine.storage.models import Attempt, Exercise, PatientExercise, PhysiatristPatient, Profile, UserRole

router = APIRouter(prefix="/attempts", tags=["attempts"])


class AttemptIn(BaseModel):
    exercise_id: str
    is_idealized: bool = False
    frames: list[dict[str, Any]]
    meta: dict[str, Any] = {}


def _assert_physiatrist_can_view(patient_id: Optional[uuid.UUID], current_user: Profile, session: Session):
    if current_user.role == UserRole.patient:
        if patient_id != current_user.id:
            raise HTTPException(status_code=403, detail="cannot access another patient's attempts")
        return
    # physiatrist: must have an assignment link to this patient
    if patient_id is None:
        raise HTTPException(status_code=403, detail="attempt has no patient_id to authorize against")
    link = session.exec(
        select(PhysiatristPatient).where(
            PhysiatristPatient.physiatrist_id == current_user.id,
            PhysiatristPatient.patient_id == patient_id,
        )
    ).first()
    if not link:
        raise HTTPException(status_code=403, detail="patient is not assigned to this physiatrist")


def _assert_prescribed(patient_id: uuid.UUID, exercise_id: str, session: Session) -> Exercise:
    exercise = session.exec(select(Exercise).where(Exercise.exercise_id == exercise_id)).first()
    if not exercise:
        raise HTTPException(
            status_code=404,
            detail=f"exercise_id '{exercise_id}' is not registered; create it via POST /exercises first",
        )
    prescribed = session.exec(
        select(PatientExercise).where(
            PatientExercise.patient_id == patient_id,
            PatientExercise.exercise_id == exercise_id,
        )
    ).first()
    if not prescribed:
        raise HTTPException(
            status_code=403,
            detail=f"exercise_id '{exercise_id}' has not been prescribed to you",
        )
    return exercise


# --- batch path: whole attempt in one request -------------------------------


@router.post("/batch", response_model=Attempt)
def submit_attempt_batch(
    payload: AttemptIn,
    current_user: Profile = Depends(require_role(UserRole.patient, UserRole.admin)),
    session: Session = Depends(get_session),
):
    if current_user.role == UserRole.admin:
        exercise = session.exec(select(Exercise).where(Exercise.exercise_id == payload.exercise_id)).first()
        if not exercise:
            raise HTTPException(
                status_code=404,
                detail=f"exercise_id '{payload.exercise_id}' is not registered; create it via POST /exercises first",
            )
        patient_id = None
    else:
        _assert_prescribed(current_user.id, payload.exercise_id, session)
        patient_id = current_user.id

    attempt = Attempt(
        exercise_id=payload.exercise_id,
        patient_id=patient_id,
        is_idealized=payload.is_idealized,
        frames=payload.frames,
        meta=payload.meta,
    )
    try:
        attempt.features = spec_for(payload.exercise_id).extract(payload.frames, payload.meta)
    except Exception:  # never lose an attempt over a feature bug; features are recomputed lazily
        attempt.features = None
    if attempt.features and not attempt.is_idealized and settings.trim_patient_frames:
        attempt.frames = slim_frames(attempt.frames)
    session.add(attempt)
    session.commit()
    session.refresh(attempt)
    return attempt


# --- read path ---------------------------------------------------------------


class ReferenceSummary(BaseModel):
    id: int
    exercise_id: str
    created_at: datetime
    frame_count: int
    meta: dict[str, Any]
    quality: QualityReport


class BulkDeleteIn(BaseModel):
    ids: list[int]


class BulkDeleteOut(BaseModel):
    deleted: int


@router.get("/references", response_model=list[ReferenceSummary])
def list_references(
    exercise_id: Optional[str] = None,
    _admin: Profile = Depends(require_role(UserRole.admin)),
    session: Session = Depends(get_session),
):
    """Idealized (reference) attempts have no patient, so they can't go through
    the assignment-based GET /attempts. Summaries only -- frames can be huge --
    plus a recording-quality report computed from them."""
    query = select(Attempt).where(Attempt.is_idealized == True).order_by(Attempt.created_at.desc())  # noqa: E712
    if exercise_id:
        query = query.where(Attempt.exercise_id == exercise_id)
    return [
        ReferenceSummary(
            id=a.id,
            exercise_id=a.exercise_id,
            created_at=a.created_at,
            frame_count=len(a.frames),
            meta=a.meta,
            quality=analyze(a.frames, a.meta),
        )
        for a in session.exec(query).all()
    ]


@router.post("/references/delete", response_model=BulkDeleteOut)
def delete_references(
    payload: BulkDeleteIn,
    _admin: Profile = Depends(require_role(UserRole.admin)),
    session: Session = Depends(get_session),
):
    """Bulk delete. Only idealized attempts can be removed here -- patient
    attempts are care records and are never deletable through this route."""
    rows = session.exec(
        select(Attempt).where(Attempt.id.in_(payload.ids), Attempt.is_idealized == True)  # noqa: E712
    ).all()
    for row in rows:
        session.delete(row)
    session.commit()
    return BulkDeleteOut(deleted=len(rows))


@router.delete("/references/{attempt_id}", response_model=BulkDeleteOut)
def delete_reference(
    attempt_id: int,
    _admin: Profile = Depends(require_role(UserRole.admin)),
    session: Session = Depends(get_session),
):
    row = session.get(Attempt, attempt_id)
    if not row or not row.is_idealized:
        raise HTTPException(status_code=404, detail=f"reference {attempt_id} not found")
    session.delete(row)
    session.commit()
    return BulkDeleteOut(deleted=1)


class AttemptHistoryItem(BaseModel):
    id: int
    exercise_id: str
    created_at: datetime
    meta: dict[str, Any]


@router.get("/history", response_model=list[AttemptHistoryItem])
def attempt_history(
    exercise_id: str,
    limit: int = 10,
    current_user: Profile = Depends(require_role(UserRole.patient)),
    session: Session = Depends(get_session),
):
    """The caller's own latest attempts (newest first) without frames, so a game can show
    previous results and adapt its parameters."""
    rows = session.exec(
        select(Attempt.id, Attempt.exercise_id, Attempt.created_at, Attempt.meta)
        .where(Attempt.patient_id == current_user.id, Attempt.exercise_id == exercise_id)
        .order_by(Attempt.created_at.desc())
        .limit(max(1, min(limit, 50)))
    ).all()
    return [AttemptHistoryItem(id=r[0], exercise_id=r[1], created_at=r[2], meta=r[3] or {}) for r in rows]


def _load_viewable(attempt_id: int, current_user: Profile, session: Session) -> Attempt:
    attempt = session.get(Attempt, attempt_id)
    if not attempt:
        raise HTTPException(status_code=404, detail=f"attempt {attempt_id} not found")
    if current_user.role == UserRole.admin and attempt.is_idealized:
        return attempt  # admins own the reference set (e.g. to export it)
    _assert_physiatrist_can_view(attempt.patient_id, current_user, session)
    return attempt


@router.get("/next-params", response_model=Optional[AnalysisOut])
def next_params(
    exercise_id: str,
    current_user: Profile = Depends(require_role(UserRole.patient)),
    session: Session = Depends(get_session),
):
    """Analysis of the caller's latest attempt; `adaptation.next_params` is what the next round should use.
    `null` before the first attempt."""
    return next_params_for(session, current_user.id, exercise_id)


@router.post("/analyze", response_model=AnalysisOut)
def analyze_unsaved(
    payload: AttemptIn,
    current_user: Profile = Depends(require_role(UserRole.admin)),
    session: Session = Depends(get_session),
):
    """Analysis of frames that are not stored (an admin's practice run)."""
    return analyze(session, exercise_id=payload.exercise_id, frames=payload.frames, meta=payload.meta)


@router.get("/{attempt_id}/analysis", response_model=AnalysisOut)
def attempt_analysis(
    attempt_id: int,
    current_user: Profile = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return analyze_attempt(session, _load_viewable(attempt_id, current_user, session))


@router.get("/{attempt_id}", response_model=Attempt)
def get_attempt(
    attempt_id: int,
    current_user: Profile = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return _load_viewable(attempt_id, current_user, session)

