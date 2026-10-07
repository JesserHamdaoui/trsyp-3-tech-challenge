"""
Exercise prescription. A physiatrist may only prescribe an exercise to a
patient already assigned to them (PhysiatristPatient must exist first) --
this keeps the two gates independent: being a patient's physiatrist doesn't
automatically prescribe anything, and prescribing requires the care
relationship to already be established.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from engine.auth.deps import get_current_user, require_role
from engine.storage.db import get_session
from engine.storage.models import Exercise, PatientExercise, PhysiatristPatient, Profile, UserRole

router = APIRouter(prefix="/prescriptions", tags=["prescriptions"])


class PrescribeIn(BaseModel):
    patient_id: uuid.UUID
    exercise_id: str


class PrescriptionOut(BaseModel):
    id: int
    patient_id: uuid.UUID
    exercise_id: str
    prescribed_by_id: uuid.UUID


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
    )
    session.add(prescription)
    session.commit()
    session.refresh(prescription)
    return PrescriptionOut(
        id=prescription.id,
        patient_id=prescription.patient_id,
        exercise_id=prescription.exercise_id,
        prescribed_by_id=prescription.prescribed_by_id,
    )


@router.get("/my-exercises", response_model=list[PrescriptionOut])
def my_exercises(
    current_user: Profile = Depends(require_role(UserRole.patient)),
    session: Session = Depends(get_session),
):
    rows = session.exec(
        select(PatientExercise).where(PatientExercise.patient_id == current_user.id)
    ).all()
    return [
        PrescriptionOut(id=r.id, patient_id=r.patient_id, exercise_id=r.exercise_id, prescribed_by_id=r.prescribed_by_id)
        for r in rows
    ]


@router.get("/patient/{patient_id}", response_model=list[PrescriptionOut])
def patient_exercises(
    patient_id: uuid.UUID,
    current_user: Profile = Depends(require_role(UserRole.physiatrist)),
    session: Session = Depends(get_session),
):
    link = session.exec(
        select(PhysiatristPatient).where(
            PhysiatristPatient.physiatrist_id == current_user.id,
            PhysiatristPatient.patient_id == patient_id,
        )
    ).first()
    if not link:
        raise HTTPException(status_code=403, detail="patient is not assigned to this physiatrist")

    rows = session.exec(select(PatientExercise).where(PatientExercise.patient_id == patient_id)).all()
    return [
        PrescriptionOut(id=r.id, patient_id=r.patient_id, exercise_id=r.exercise_id, prescribed_by_id=r.prescribed_by_id)
        for r in rows
    ]
