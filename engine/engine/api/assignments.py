"""
Physiatrist<->patient assignment. Only a physiatrist can create an
assignment (a patient can't assign themselves a doctor), and only onto a
user who actually has the `patient` role. This table is the sole gate for
"may this physiatrist see this patient's data" -- enforced here at write
time and re-checked by any future endpoint that serves patient-scoped data
(attempts, trends, difficulty state) to a physiatrist caller.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from engine.auth.deps import get_current_user, require_role
from engine.storage.db import get_session
from engine.storage.models import PhysiatristPatient, Profile, UserRole

router = APIRouter(prefix="/assignments", tags=["assignments"])


class AssignIn(BaseModel):
    patient_id: uuid.UUID


class AssignmentOut(BaseModel):
    id: int
    physiatrist_id: uuid.UUID
    patient_id: uuid.UUID


@router.post("", response_model=AssignmentOut)
def assign_patient(
    payload: AssignIn,
    current_user: Profile = Depends(require_role(UserRole.physiatrist)),
    session: Session = Depends(get_session),
):
    patient = session.get(Profile, payload.patient_id)
    if not patient or patient.role != UserRole.patient:
        raise HTTPException(status_code=404, detail=f"no patient with id {payload.patient_id}")

    existing = session.exec(
        select(PhysiatristPatient).where(
            PhysiatristPatient.physiatrist_id == current_user.id,
            PhysiatristPatient.patient_id == payload.patient_id,
        )
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail="patient already assigned to this physiatrist")

    link = PhysiatristPatient(physiatrist_id=current_user.id, patient_id=payload.patient_id)
    session.add(link)
    session.commit()
    session.refresh(link)
    return AssignmentOut(id=link.id, physiatrist_id=link.physiatrist_id, patient_id=link.patient_id)


@router.get("/my-patients", response_model=list[AssignmentOut])
def my_patients(
    current_user: Profile = Depends(require_role(UserRole.physiatrist)),
    session: Session = Depends(get_session),
):
    links = session.exec(
        select(PhysiatristPatient).where(PhysiatristPatient.physiatrist_id == current_user.id)
    ).all()
    return [AssignmentOut(id=l.id, physiatrist_id=l.physiatrist_id, patient_id=l.patient_id) for l in links]


@router.get("/my-physiatrists", response_model=list[AssignmentOut])
def my_physiatrists(
    current_user: Profile = Depends(require_role(UserRole.patient)),
    session: Session = Depends(get_session),
):
    links = session.exec(
        select(PhysiatristPatient).where(PhysiatristPatient.patient_id == current_user.id)
    ).all()
    return [AssignmentOut(id=l.id, physiatrist_id=l.physiatrist_id, patient_id=l.patient_id) for l in links]
