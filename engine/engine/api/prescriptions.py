"""
Exercise prescription. A physiatrist may only prescribe an exercise to a
patient already assigned to them (PhysiatristPatient must exist first) --
this keeps the two gates independent: being a patient's physiatrist doesn't
automatically prescribe anything, and prescribing requires the care
relationship to already be established.
"""

import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from engine.auth.deps import get_current_user, require_role
from engine.storage.db import get_session
from engine.storage.models import Exercise, PatientExercise, PhysiatristPatient, Profile, UserRole

router = APIRouter(prefix="/prescriptions", tags=["prescriptions"])


Hand = Optional[Literal["left", "right"]]


class PrescribeIn(BaseModel):
    patient_id: uuid.UUID
    exercise_id: str
    hand: Hand = None


class HandIn(BaseModel):
    hand: Hand = None


class PrescriptionOut(BaseModel):
    id: int
    patient_id: uuid.UUID
    exercise_id: str
    prescribed_by_id: uuid.UUID
    hand: Hand = None


def _out(r: PatientExercise) -> PrescriptionOut:
    return PrescriptionOut(
        id=r.id, patient_id=r.patient_id, exercise_id=r.exercise_id, prescribed_by_id=r.prescribed_by_id, hand=r.hand  # type: ignore[arg-type]
    )


@router.post("", response_model=PrescriptionOut)
def prescribe_exercise(
    payload: PrescribeIn,
    current_user: Profile = Depends(require_role(UserRole.physiatrist)),
    session: Session = Depends(get_session),
):
    link = session.exec(
        select(PhysiatristPatient).where(
            PhysiatristPatient.physiatrist_id == current_user.id,
            PhysiatristPatient.patient_id == payload.patient_id,
        )
    ).first()
    if not link:
        raise HTTPException(status_code=403, detail="patient is not assigned to this physiatrist")

    exercise = session.exec(
        select(Exercise).where(Exercise.exercise_id == payload.exercise_id)
    ).first()
    if not exercise:
        raise HTTPException(status_code=404, detail=f"exercise_id '{payload.exercise_id}' not found")

    existing = session.exec(
        select(PatientExercise).where(
            PatientExercise.patient_id == payload.patient_id,
            PatientExercise.exercise_id == payload.exercise_id,
        )
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail="exercise already prescribed to this patient")

    prescription = PatientExercise(
        patient_id=payload.patient_id,
        exercise_id=payload.exercise_id,
        prescribed_by_id=current_user.id,
        hand=payload.hand,
    )
    session.add(prescription)
    session.commit()
    session.refresh(prescription)
    return _out(prescription)


@router.get("/my-exercises", response_model=list[PrescriptionOut])
def my_exercises(
    current_user: Profile = Depends(require_role(UserRole.patient)),
    session: Session = Depends(get_session),
):
    rows = session.exec(
        select(PatientExercise).where(PatientExercise.patient_id == current_user.id)
    ).all()
    return [_out(r) for r in rows]


@router.delete("/{prescription_id}")
def remove_prescription(
    prescription_id: int,
    current_user: Profile = Depends(require_role(UserRole.physiatrist)),
    session: Session = Depends(get_session),
):
    """Stops a prescription for a patient the caller looks after. Past attempts stay."""
    row = session.get(PatientExercise, prescription_id)
    if not row:
        raise HTTPException(status_code=404, detail="prescription not found")
    link = session.exec(
        select(PhysiatristPatient).where(
            PhysiatristPatient.physiatrist_id == current_user.id,
            PhysiatristPatient.patient_id == row.patient_id,
        )
    ).first()
    if not link:
        raise HTTPException(status_code=403, detail="patient is not assigned to this physiatrist")
    session.delete(row)
    session.commit()
    return {"removed": True}


@router.patch("/{prescription_id}/hand", response_model=PrescriptionOut)
def set_hand(
    prescription_id: int,
    payload: HandIn,
    current_user: Profile = Depends(require_role(UserRole.physiatrist)),
    session: Session = Depends(get_session),
):
    """Fixes which hand the patient trains with (or clears it so the patient is asked each round)."""
    row = session.get(PatientExercise, prescription_id)
    if not row:
        raise HTTPException(status_code=404, detail="prescription not found")
    link = session.exec(
        select(PhysiatristPatient).where(
            PhysiatristPatient.physiatrist_id == current_user.id,
            PhysiatristPatient.patient_id == row.patient_id,
        )
    ).first()
    if not link:
        raise HTTPException(status_code=403, detail="patient is not assigned to this physiatrist")
    row.hand = payload.hand
    session.add(row)
    session.commit()
    session.refresh(row)
    return _out(row)
