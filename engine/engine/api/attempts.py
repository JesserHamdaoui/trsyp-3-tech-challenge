"""
Attempt ingestion, auth-gated, two paths:

  - Live path (the real one games use): POST /attempts/begin opens an
    in-progress attempt and returns its id; the client then opens
    WS /attempts/{id}/stream and pushes one JSON frame per message at full
    sensor/CV rate (>100Hz glove, ~30fps CV) -- these are buffered in Redis
    (engine.storage.cache), NOT written to Postgres per frame, since that
    would be one DB round-trip per frame for no reason. POST
    /attempts/{id}/end pulls the buffered frames back out, writes the
    completed Attempt row to Postgres in one shot, and clears the buffer.

  - Batch path: POST /attempts/batch accepts a whole attempt (all frames)
    in one request, for offline/already-recorded data (e.g. re-uploading a
    file from the old cv-poc scripts). A patient must be prescribed the
    exercise, same as the live path. An admin (demonstrator role) may also
    use this path to submit is_idealized=true attempts that seed/retrain an
    exercise's reference model -- admins skip the prescription check
    entirely (they aren't a patient and aren't prescribed anything) and
    their attempts are stored with patient_id left null, since the attempt
    isn't tied to any patient's care.

A patient acts only as themselves (patient_id is taken from the token,
never trusted from the client) and only for an exercise they've actually
been prescribed (PatientExercise). A physiatrist may only read attempts of
a patient assigned to them (PhysiatristPatient). No feature extraction or
scoring yet (step 2/4 of the roadmap).
"""

import uuid
from typing import Any, Optional

import jwt
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from sqlmodel import Session, select

from engine.auth.deps import get_current_user, require_role
from engine.auth.security import decode_access_token
from engine.storage import cache
from engine.storage.db import get_session
from engine.storage.models import Attempt, Exercise, PatientExercise, PhysiatristPatient, Profile, UserRole

router = APIRouter(prefix="/attempts", tags=["attempts"])


class AttemptIn(BaseModel):
    exercise_id: str
    is_idealized: bool = False
    frames: list[dict[str, Any]]
    meta: dict[str, Any] = {}


class BeginAttemptIn(BaseModel):
    exercise_id: str
    is_idealized: bool = False


class BeginAttemptOut(BaseModel):
    attempt_id: str


class EndAttemptIn(BaseModel):
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


# --- live path: begin -> stream -> end -------------------------------------


@router.post("/begin", response_model=BeginAttemptOut)
def begin_attempt(
    payload: BeginAttemptIn,
    current_user: Profile = Depends(require_role(UserRole.patient)),
    session: Session = Depends(get_session),
):
    _assert_prescribed(current_user.id, payload.exercise_id, session)

    attempt_id = uuid.uuid4().hex
    cache.start_attempt_buffer(
        attempt_id=attempt_id,
        patient_id=str(current_user.id),
        exercise_id=payload.exercise_id,
        is_idealized=payload.is_idealized,
    )
    return BeginAttemptOut(attempt_id=attempt_id)


@router.websocket("/{attempt_id}/stream")
async def stream_attempt(websocket: WebSocket, attempt_id: str):
    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=4401)
        return
    try:
        payload = decode_access_token(token)
        user_id = str(uuid.UUID(payload["sub"]))
    except (jwt.PyJWTError, KeyError, ValueError):
        await websocket.close(code=4401)
        return

    meta = cache.get_attempt_meta(attempt_id)
    if meta is None:
        await websocket.close(code=4404)
        return
    if meta["patient_id"] != user_id:
        await websocket.close(code=4403)
        return

    await websocket.accept()
    try:
        while True:
            frame = await websocket.receive_json()
            count = cache.push_frame(attempt_id, frame)
            await websocket.send_json({"ack": count})
    except WebSocketDisconnect:
        pass


@router.post("/{attempt_id}/end", response_model=Attempt)
def end_attempt(
    attempt_id: str,
    payload: EndAttemptIn,
    current_user: Profile = Depends(require_role(UserRole.patient)),
    session: Session = Depends(get_session),
):
    meta = cache.get_attempt_meta(attempt_id)
    if meta is None:
        raise HTTPException(status_code=404, detail=f"no in-progress attempt '{attempt_id}' (never started, already ended, or expired)")
    if meta["patient_id"] != str(current_user.id):
        raise HTTPException(status_code=403, detail="cannot end another patient's attempt")

    frames = cache.get_all_frames(attempt_id)

    attempt = Attempt(
        exercise_id=meta["exercise_id"],
        patient_id=current_user.id,
        is_idealized=meta["is_idealized"],
        frames=frames,
        meta=payload.meta,
    )
    session.add(attempt)
    session.commit()
    session.refresh(attempt)

    cache.clear_attempt_buffer(attempt_id)
    return attempt


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
    session.add(attempt)
    session.commit()
    session.refresh(attempt)
    return attempt


# --- read path ---------------------------------------------------------------


@router.get("/{attempt_id}", response_model=Attempt)
def get_attempt(
    attempt_id: int,
    current_user: Profile = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    attempt = session.get(Attempt, attempt_id)
    if not attempt:
        raise HTTPException(status_code=404, detail=f"attempt {attempt_id} not found")
    _assert_physiatrist_can_view(attempt.patient_id, current_user, session)
    return attempt


@router.get("", response_model=list[Attempt])
def list_attempts(
    exercise_id: Optional[str] = None,
    patient_id: Optional[uuid.UUID] = None,
    current_user: Profile = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if current_user.role == UserRole.patient:
        # patients only ever see their own attempts, regardless of query param
        effective_patient_id = current_user.id
    else:
        if patient_id is None:
            raise HTTPException(status_code=400, detail="physiatrist must pass patient_id")
        _assert_physiatrist_can_view(patient_id, current_user, session)
        effective_patient_id = patient_id

    query = select(Attempt).where(Attempt.patient_id == effective_patient_id)
    if exercise_id:
        query = query.where(Attempt.exercise_id == exercise_id)
    return session.exec(query).all()
