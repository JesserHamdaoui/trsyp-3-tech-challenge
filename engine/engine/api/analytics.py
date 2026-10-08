"""
Admin analytics: platform-wide usage and patient-performance rollups for the
admin dashboard. Read-only. Attempt rows are queried column-by-column (never
`frames`) since frames are the heavy JSONB payload.
"""

import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlmodel import Session, select

from engine.auth.deps import require_role
from engine.storage.db import get_session
from engine.storage.models import (
    Attempt,
    Exercise,
    PatientExercise,
    PhysiatristPatient,
    Profile,
    UserRole,
)

router = APIRouter(prefix="/analytics", tags=["analytics"])


class Totals(BaseModel):
    patients: int
    physiatrists: int
    admins: int
    exercises: int
    prescriptions: int
    assignments: int
    attempts: int
    references: int


class DayPoint(BaseModel):
    date: date
    attempts: int
    avg_accuracy: Optional[float]


class Outcomes(BaseModel):
    hits: int
    leaks: int
    misses: int


class ExerciseStat(BaseModel):
    exercise_id: str
    display_name: str
    prescriptions: int
    patients_played: int
    attempts: int
    avg_accuracy: Optional[float]
    avg_score: Optional[float]


class PhysiatristStat(BaseModel):
    id: str
    name: str
    patients: int
    prescriptions: int
    patient_attempts: int
    active_patients: int


class Overview(BaseModel):
    days: int
    totals: Totals
    active_patients: int
    adherence_rate: Optional[float]
    prescriptions_started: int
    avg_accuracy: Optional[float]
    outcomes: Outcomes
    by_day: list[DayPoint]
    by_exercise: list[ExerciseStat]
    by_physiatrist: list[PhysiatristStat]


def _accuracy(meta: dict[str, Any]) -> Optional[float]:
    hits, leaks, misses = (meta.get(k) for k in ("hits", "leaks", "misses"))
    if not all(isinstance(v, int) and not isinstance(v, bool) for v in (hits, leaks, misses)):
        return None
    total = hits + leaks + misses
    return hits / total if total else None


def _mean(values: list[float]) -> Optional[float]:
    return round(sum(values) / len(values), 3) if values else None


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


@router.get("/overview", response_model=Overview)
def overview(
    days: int = Query(30, ge=1, le=365),
    _admin: Profile = Depends(require_role(UserRole.admin)),
    session: Session = Depends(get_session),
):
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=days)

    profiles = session.exec(select(Profile)).all()
    exercises = session.exec(select(Exercise)).all()
    prescriptions = session.exec(select(PatientExercise)).all()
    assignments = session.exec(select(PhysiatristPatient)).all()

    # never select Attempt.frames
    rows = session.exec(
        select(Attempt.id, Attempt.exercise_id, Attempt.patient_id, Attempt.is_idealized, Attempt.created_at, Attempt.meta)
    ).all()
    patient_rows = [r for r in rows if not r.is_idealized and r.patient_id is not None]
    window = [r for r in patient_rows if _aware(r.created_at) >= since]

    # --- totals ---
    role_count = defaultdict(int)
    for p in profiles:
        role_count[p.role] += 1
    totals = Totals(
        patients=role_count[UserRole.patient],
        physiatrists=role_count[UserRole.physiatrist],
        admins=role_count[UserRole.admin],
        exercises=len(exercises),
        prescriptions=len(prescriptions),
        assignments=len(assignments),
        attempts=len(patient_rows),
        references=sum(1 for r in rows if r.is_idealized),
    )

    # --- adherence: prescriptions with at least one attempt ever ---
    played_pairs = {(r.patient_id, r.exercise_id) for r in patient_rows}
    started = sum(1 for rx in prescriptions if (rx.patient_id, rx.exercise_id) in played_pairs)
    adherence = round(started / len(prescriptions), 3) if prescriptions else None

    # --- outcomes + accuracy over the window ---
    outcomes = Outcomes(hits=0, leaks=0, misses=0)
    accuracies: list[float] = []
    for r in window:
        acc = _accuracy(r.meta)
        if acc is None:
            continue
        accuracies.append(acc)
        outcomes.hits += r.meta["hits"]
        outcomes.leaks += r.meta["leaks"]
        outcomes.misses += r.meta["misses"]

    # --- per day (zero-filled so charts have a continuous axis) ---
    per_day: dict[date, list] = defaultdict(list)
    for r in window:
        per_day[_aware(r.created_at).date()].append(r)
    by_day = []
    for i in range(days - 1, -1, -1):
        d = (now - timedelta(days=i)).date()
        day_rows = per_day.get(d, [])
        by_day.append(
            DayPoint(
                date=d,
                attempts=len(day_rows),
                avg_accuracy=_mean([a for r in day_rows if (a := _accuracy(r.meta)) is not None]),
            )
        )

    # --- per exercise ---
    by_exercise = []
    for ex in exercises:
        ex_rows = [r for r in window if r.exercise_id == ex.exercise_id]
        scores = [r.meta["score"] for r in ex_rows if isinstance(r.meta.get("score"), (int, float))]
        by_exercise.append(
            ExerciseStat(
                exercise_id=ex.exercise_id,
                display_name=ex.display_name,
                prescriptions=sum(1 for rx in prescriptions if rx.exercise_id == ex.exercise_id),
                patients_played=len({r.patient_id for r in ex_rows}),
                attempts=len(ex_rows),
                avg_accuracy=_mean([a for r in ex_rows if (a := _accuracy(r.meta)) is not None]),
                avg_score=_mean(scores),
            )
        )
    by_exercise.sort(key=lambda e: e.attempts, reverse=True)

    # --- per physiatrist ---
    active_cutoff = now - timedelta(days=7)
    patients_of: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    for a in assignments:
        patients_of[a.physiatrist_id].add(a.patient_id)
    by_physiatrist = []
    for p in profiles:
        if p.role != UserRole.physiatrist:
            continue
        mine = patients_of.get(p.id, set())
        by_physiatrist.append(
            PhysiatristStat(
                id=str(p.id),
                name=p.full_name or p.email,
                patients=len(mine),
                prescriptions=sum(1 for rx in prescriptions if rx.prescribed_by_id == p.id),
                patient_attempts=sum(1 for r in window if r.patient_id in mine),
                active_patients=len(
                    {r.patient_id for r in patient_rows if r.patient_id in mine and _aware(r.created_at) >= active_cutoff}
                ),
            )
        )
    by_physiatrist.sort(key=lambda s: s.patient_attempts, reverse=True)

    return Overview(
        days=days,
        totals=totals,
        active_patients=len({r.patient_id for r in patient_rows if _aware(r.created_at) >= active_cutoff}),
        adherence_rate=adherence,
        prescriptions_started=started,
        avg_accuracy=_mean(accuracies),
        outcomes=outcomes,
        by_day=by_day,
        by_exercise=by_exercise,
        by_physiatrist=by_physiatrist,
    )
