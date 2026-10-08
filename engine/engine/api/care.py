"""
Physiatrist dashboards: everything is scoped to the caller's assigned patients
(PhysiatristPatient). Read-only rollups plus unassigning. Attempt rows are read
column-by-column, never `frames`.
"""

import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select

from engine.analysis import AnalysisOut, analyze_attempt, _accuracy
from engine.auth.deps import require_role
from engine.storage.db import get_session
from engine.storage.models import Attempt, Exercise, PatientExercise, PhysiatristPatient, Profile, UserRole
from engine.triage import triage

router = APIRouter(prefix="/care", tags=["care"])


class ReasonOut(BaseModel):
    code: str
    text: str
    severity: str


class PatientSummary(BaseModel):
    id: str
    email: str
    full_name: str
    assigned_at: datetime
    status: str  # needs_attention | on_track | new
    reasons: list[ReasonOut]
    trend: str
    prescriptions: list[str]  # exercise ids
    prescription_ids: dict[str, int]  # exercise id -> prescription id (to remove it)
    rounds: int
    rounds_7d: int
    last_round_at: Optional[datetime]
    recent_accuracy: Optional[float]
    avg_accuracy: Optional[float]


class DayPoint(BaseModel):
    date: date
    attempts: int
    avg_accuracy: Optional[float]


class Mover(BaseModel):
    id: str
    name: str
    from_accuracy: float
    to_accuracy: float


class Overview(BaseModel):
    days: int
    patients: int
    active_patients: int  # played in the last 7 days
    needs_attention: int
    adherence_rate: Optional[float]  # share of prescriptions with at least one round
    avg_accuracy: Optional[float]
    rounds: int
    by_day: list[DayPoint]
    attention: list[PatientSummary]
    movers: list[Mover]
    outcomes: dict[str, int]


class AttemptRow(BaseModel):
    id: int
    exercise_id: str
    created_at: datetime
    accuracy: Optional[float]
    score: Optional[float]
    hits: Optional[int]
    leaks: Optional[int]
    misses: Optional[int]
    params: Optional[dict[str, Any]]


class PrescriptionRow(BaseModel):
    id: int
    exercise_id: str
    display_name: str
    assigned_at: datetime
    rounds: int
    last_round_at: Optional[datetime]
    avg_accuracy: Optional[float]
    hand: Optional[str] = None


class PatientDetail(BaseModel):
    summary: PatientSummary
    prescriptions: list[PrescriptionRow]
    attempts: list[AttemptRow]  # newest first
    latest_analysis: Optional[AnalysisOut]


def _utc(t: datetime) -> datetime:
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _assigned(session: Session, physiatrist_id: uuid.UUID) -> list[tuple[Profile, datetime]]:
    rows = session.exec(
        select(Profile, PhysiatristPatient.assigned_at)
        .join(PhysiatristPatient, PhysiatristPatient.patient_id == Profile.id)
        .where(PhysiatristPatient.physiatrist_id == physiatrist_id)
        .order_by(Profile.full_name)
    ).all()
    return [(p, a) for p, a in rows]


def _assert_assigned(session: Session, physiatrist_id: uuid.UUID, patient_id: uuid.UUID) -> PhysiatristPatient:
    link = session.exec(
        select(PhysiatristPatient).where(
            PhysiatristPatient.physiatrist_id == physiatrist_id, PhysiatristPatient.patient_id == patient_id
        )
    ).first()
    if not link:
        raise HTTPException(status_code=403, detail="patient is not assigned to this physiatrist")
    return link


def _load_rounds(session: Session, patient_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[tuple[Any, ...]]]:
    """patient -> [(id, exercise_id, created_at, meta)] oldest first, real rounds only, no frames."""
    out: dict[uuid.UUID, list[tuple[Any, ...]]] = defaultdict(list)
    if not patient_ids:
        return out
    rows = session.exec(
        select(Attempt.id, Attempt.patient_id, Attempt.exercise_id, Attempt.created_at, Attempt.meta)
        .where(Attempt.patient_id.in_(patient_ids), Attempt.is_idealized == False)  # noqa: E712
        .order_by(Attempt.created_at)
    ).all()
    for aid, pid, ex, at, meta in rows:
        out[pid].append((aid, ex, _utc(at), meta or {}))
    return out


def _summarize(
    p: Profile, assigned_at: datetime, rounds: list[tuple[Any, ...]], prescribed: list[PatientExercise], now: datetime
) -> PatientSummary:
    accs = [a for a in (_accuracy(r[3]) for r in rounds) if a is not None]
    last = rounds[-1][2] if rounds else None
    t = triage(
        accuracy_series=accs,
        last_round_at=last,
        rounds=len(rounds),
        prescriptions=len(prescribed),
        assigned_at=_utc(assigned_at),
        now=now,
    )
    week = now - timedelta(days=7)
    return PatientSummary(
        id=str(p.id),
        email=p.email,
        full_name=p.full_name,
        assigned_at=assigned_at,
        status=t.status,
        reasons=[ReasonOut(code=r.code, text=r.text, severity=r.severity) for r in t.reasons],
        trend=t.trend,
        prescriptions=[r.exercise_id for r in prescribed],
        prescription_ids={r.exercise_id: r.id for r in prescribed},
        rounds=len(rounds),
        rounds_7d=sum(1 for r in rounds if r[2] >= week),
        last_round_at=last,
        recent_accuracy=t.recent_accuracy,
        avg_accuracy=round(sum(accs) / len(accs), 3) if accs else None,
    )


def _prescriptions_by_patient(session: Session, patient_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[PatientExercise]]:
    out: dict[uuid.UUID, list[PatientExercise]] = defaultdict(list)
    if patient_ids:
        for r in session.exec(select(PatientExercise).where(PatientExercise.patient_id.in_(patient_ids))).all():
            out[r.patient_id].append(r)
    return out


def _summaries(session: Session, physiatrist_id: uuid.UUID) -> list[PatientSummary]:
    now = datetime.now(timezone.utc)
    assigned = _assigned(session, physiatrist_id)
    ids = [p.id for p, _ in assigned]
    rounds = _load_rounds(session, ids)
    rx = _prescriptions_by_patient(session, ids)
    return [_summarize(p, at, rounds.get(p.id, []), rx.get(p.id, []), now) for p, at in assigned]


_SEVERITY = {"high": 0, "medium": 1, "low": 2}


@router.get("/patients", response_model=list[PatientSummary])
def my_patients(
    current_user: Profile = Depends(require_role(UserRole.physiatrist)),
    session: Session = Depends(get_session),
):
    """The caller's patients with a triage status and activity summary."""
    return _summaries(session, current_user.id)


@router.get("/overview", response_model=Overview)
def overview(
    days: int = Query(30, ge=1, le=365),
    current_user: Profile = Depends(require_role(UserRole.physiatrist)),
    session: Session = Depends(get_session),
):
    now = datetime.now(timezone.utc)
    assigned = _assigned(session, current_user.id)
    ids = [p.id for p, _ in assigned]
    rounds = _load_rounds(session, ids)
    rx = _prescriptions_by_patient(session, ids)
    names = {p.id: (p.full_name or p.email) for p, _ in assigned}

    summaries = [
        _summarize(p, at, rounds.get(p.id, []), rx.get(p.id, []), now) for p, at in assigned
    ]
    attention = [s for s in summaries if s.status == "needs_attention"]
    attention.sort(key=lambda s: (min(_SEVERITY[r.severity] for r in s.reasons), -len(s.reasons)))

    since = now - timedelta(days=days)
    per_day: dict[date, list[Optional[float]]] = defaultdict(list)
    outcomes = {"hits": 0, "leaks": 0, "misses": 0}
    in_range_accs: list[float] = []
    n_rounds = 0
    for pid in ids:
        for _, _, at, meta in rounds.get(pid, []):
            if at < since:
                continue
            n_rounds += 1
            acc = _accuracy(meta)
            per_day[at.date()].append(acc)
            if acc is not None:
                in_range_accs.append(acc)
                for k in outcomes:
                    outcomes[k] += int(meta.get(k) or 0)
    by_day = []
    for i in range(days):
        d = (now - timedelta(days=days - 1 - i)).date()
        vals = per_day.get(d, [])
        scored = [v for v in vals if v is not None]
        by_day.append(DayPoint(date=d, attempts=len(vals), avg_accuracy=round(sum(scored) / len(scored), 3) if scored else None))

    started = sum(
        1
        for pid in ids
        for r in rx.get(pid, [])
        if any(a[1] == r.exercise_id for a in rounds.get(pid, []))
    )
    total_rx = sum(len(v) for v in rx.values())

    movers: list[Mover] = []
    for pid in ids:
        accs = [a for a in (_accuracy(r[3]) for r in rounds.get(pid, [])) if a is not None]
        if len(accs) >= 4:
            half = len(accs) // 2
            before, after = sum(accs[:half]) / half, sum(accs[half:]) / (len(accs) - half)
            if after - before >= 0.05:
                movers.append(Mover(id=str(pid), name=names[pid], from_accuracy=round(before, 3), to_accuracy=round(after, 3)))
    movers.sort(key=lambda m: m.to_accuracy - m.from_accuracy, reverse=True)

    week = now - timedelta(days=7)
    return Overview(
        days=days,
        patients=len(ids),
        active_patients=sum(1 for s in summaries if s.last_round_at and s.last_round_at >= week),
        needs_attention=len(attention),
        adherence_rate=round(started / total_rx, 3) if total_rx else None,
        avg_accuracy=round(sum(in_range_accs) / len(in_range_accs), 3) if in_range_accs else None,
        rounds=n_rounds,
        by_day=by_day,
        attention=attention[:8],
        movers=movers[:5],
        outcomes=outcomes,
    )


@router.get("/patients/{patient_id}", response_model=PatientDetail)
def patient_detail(
    patient_id: uuid.UUID,
    current_user: Profile = Depends(require_role(UserRole.physiatrist)),
    session: Session = Depends(get_session),
):
    link = _assert_assigned(session, current_user.id, patient_id)
    patient = session.get(Profile, patient_id)
    if not patient:
        raise HTTPException(status_code=404, detail="patient not found")

    now = datetime.now(timezone.utc)
    rounds = _load_rounds(session, [patient_id]).get(patient_id, [])
    rx = _prescriptions_by_patient(session, [patient_id]).get(patient_id, [])
    names = {e.exercise_id: e.display_name for e in session.exec(select(Exercise)).all()}

    summary = _summarize(patient, link.assigned_at, rounds, rx, now)

    prescriptions = []
    for r in rx:
        mine = [a for a in rounds if a[1] == r.exercise_id]
        accs = [a for a in (_accuracy(m[3]) for m in mine) if a is not None]
        prescriptions.append(
            PrescriptionRow(
                id=r.id,
                exercise_id=r.exercise_id,
                display_name=names.get(r.exercise_id, r.exercise_id),
                assigned_at=r.assigned_at,
                rounds=len(mine),
                last_round_at=mine[-1][2] if mine else None,
                avg_accuracy=round(sum(accs) / len(accs), 3) if accs else None,
                hand=r.hand,
            )
        )

    rows = []
    for aid, ex, at, meta in reversed(rounds[-60:]):
        acc = _accuracy(meta)
        rows.append(
            AttemptRow(
                id=aid,
                exercise_id=ex,
                created_at=at,
                accuracy=None if acc is None else round(acc, 3),
                score=meta.get("score") if isinstance(meta.get("score"), (int, float)) else None,
                hits=meta.get("hits") if isinstance(meta.get("hits"), int) else None,
                leaks=meta.get("leaks") if isinstance(meta.get("leaks"), int) else None,
                misses=meta.get("misses") if isinstance(meta.get("misses"), int) else None,
                params=meta.get("params") if isinstance(meta.get("params"), dict) else None,
            )
        )

    latest_analysis = None
    if rounds:
        last = session.get(Attempt, rounds[-1][0])
        if last:
            try:
                latest_analysis = analyze_attempt(session, last)
            except Exception:  # the dashboard must still load if one analysis fails
                latest_analysis = None

    return PatientDetail(summary=summary, prescriptions=prescriptions, attempts=rows, latest_analysis=latest_analysis)


@router.delete("/patients/{patient_id}")
def unassign_patient(
    patient_id: uuid.UUID,
    current_user: Profile = Depends(require_role(UserRole.physiatrist)),
    session: Session = Depends(get_session),
):
    """Ends the care relationship. The patient's data and the prescriptions this physiatrist made stay in place."""
    link = _assert_assigned(session, current_user.id, patient_id)
    session.delete(link)
    session.commit()
    return {"unassigned": True}
