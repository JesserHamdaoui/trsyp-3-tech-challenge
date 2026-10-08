"""
Persistence entities. Identity now lives in Supabase Auth (auth.users);
Profile is this app's companion row keyed 1:1 by that same UUID, holding the
fields Supabase Auth doesn't -- role and full_name. We never create a
Profile without a matching auth.users row (engine.api.auth creates both
together via the Supabase Admin API), and every other table's "who"
columns are UUID FKs to profile.id rather than our own serial ids.

Exercise (reference-model registry key) and Attempt (raw frames + extracted
features, JSONB columns since the feature set is still evolving -- see PDF
S4.6). PhysiatristPatient is the assignment join table (many-to-many: a
patient could in principle see more than one physiatrist over time, and a
physiatrist has many patients). PatientExercise is the prescription: a
physiatrist assigns an exercise from the global catalog to a specific
patient, and a patient may only submit attempts for exercises they've been
prescribed -- Exercise itself stays a shared catalog (same reference model,
same feature schema reused across every patient doing that exercise) rather
than being duplicated per patient. Scoring, trend, aggregation, and
adaptation tables land in later steps once those layers exist.
"""

import enum
import uuid as uuid_module
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import Column, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UserRole(str, enum.Enum):
    physiatrist = "physiatrist"
    patient = "patient"
    admin = "admin"  # demonstrator role: submits is_idealized=true attempts that seed/retrain an exercise's reference model, not tied to any physiatrist/patient assignment


class Profile(SQLModel, table=True):
    """App-specific companion to a Supabase auth.users row, keyed by the
    same UUID (Supabase issues it at signup; we never generate our own).
    `role` gates which endpoints and data an authenticated request can
    touch (see engine.auth.deps for the dependency that enforces this)."""

    id: uuid_module.UUID = Field(primary_key=True)
    email: str = Field(index=True, unique=True)
    role: UserRole = Field(index=True)
    full_name: str = ""
    created_at: datetime = Field(default_factory=utcnow)


class PhysiatristPatient(SQLModel, table=True):
    """Assignment: which physiatrist(s) a patient is under care of. A row
    existing is the only thing that grants a physiatrist read/write access
    to that patient's attempts, trends, and difficulty state -- enforced in
    the API layer, not implied by role alone."""

    __table_args__ = (UniqueConstraint("physiatrist_id", "patient_id"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    physiatrist_id: uuid_module.UUID = Field(index=True, foreign_key="profile.id")
    patient_id: uuid_module.UUID = Field(index=True, foreign_key="profile.id")
    assigned_at: datetime = Field(default_factory=utcnow)


class Exercise(SQLModel, table=True):
    """A named exercise (e.g. 'fist_close', 'piano_isolated_press'), shared
    across every patient who does it -- one reference model and feature
    schema per exercise, not per patient. Games never hardcode exercise
    logic into the engine, they just tag attempts with an exercise_id that
    must exist here first."""

    id: Optional[int] = Field(default=None, primary_key=True)
    exercise_id: str = Field(index=True, unique=True)
    display_name: str
    description: str = ""
    created_at: datetime = Field(default_factory=utcnow)


class PatientExercise(SQLModel, table=True):
    """Prescription: a physiatrist assigns an exercise from the catalog to
    a specific patient. This is the sole gate for "may this patient submit
    attempts for this exercise" -- a patient being assigned to a
    physiatrist (PhysiatristPatient) does not by itself grant access to any
    exercise; the physiatrist must explicitly prescribe it."""

    __table_args__ = (UniqueConstraint("patient_id", "exercise_id"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    patient_id: uuid_module.UUID = Field(index=True, foreign_key="profile.id")
    exercise_id: str = Field(index=True, foreign_key="exercise.exercise_id")
    prescribed_by_id: uuid_module.UUID = Field(foreign_key="profile.id")
    assigned_at: datetime = Field(default_factory=utcnow)
    # "left" | "right" when the physiatrist fixes which hand the patient trains; None = the patient is asked each round
    hand: Optional[str] = Field(default=None)


class Attempt(SQLModel, table=True):
    """One recorded attempt at an exercise. `patient_id` is set for a real
    patient attempt and left null for an admin-submitted idealized/reference
    attempt (an admin demonstrator isn't a patient and isn't prescribed
    anything -- their attempts exist purely to seed/retrain a reference
    model, not to be tracked against a care relationship). `frames` is the
    raw per-frame CV/sensor record list (schema owned by the sensing layer,
    opaque here). `features` is filled in once feature extraction runs
    (step 2+). `meta` holds game-supplied context (target_finger,
    target_dimension, raw game outcome) -- the engine never interprets it,
    only stores and passes it through to scoring/aggregation."""

    id: Optional[int] = Field(default=None, primary_key=True)
    exercise_id: str = Field(index=True, foreign_key="exercise.exercise_id")
    patient_id: Optional[uuid_module.UUID] = Field(default=None, index=True, foreign_key="profile.id")
    is_idealized: bool = Field(default=False, index=True)
    created_at: datetime = Field(default_factory=utcnow, index=True)

    frames: list[dict[str, Any]] = Field(sa_column=Column(JSONB), default_factory=list)
    meta: dict[str, Any] = Field(sa_column=Column(JSONB), default_factory=dict)
    features: Optional[dict[str, float]] = Field(sa_column=Column(JSONB), default=None)
