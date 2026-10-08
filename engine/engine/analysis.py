"""
Orchestrates the per-attempt analysis pipeline:

    frames + meta --features--> flat features
        --scoring--> deviation from the idealized reference (+ most-affecting features)
        --history--> comparison with the previous attempt, trend over recent attempts
        --adapt--> next game parameters with reasons

Exposed through the attempts API (`GET /attempts/{id}/analysis`,
`POST /attempts/analyze`, `GET /attempts/next-params`). Adaptation exists for
Piano Press and Pinch Flight (engine/games.py); other exercises get everything except `adaptation`.
"""

from datetime import datetime
from typing import Any, Optional
import uuid

from pydantic import BaseModel
from sqlmodel import Session, select

from engine.adapt.common import Adaptation
from engine.games import GameSpec, spec_for
from engine.scoring.reference import FINGERS, Deviation, ReferenceProfile, build_profile, describe, deviation
from engine.storage.models import Attempt
from engine.trend.trend import analyze_trend

HISTORY_LIMIT = 12
REFERENCE_LIMIT = 60


# ---- response models --------------------------------------------------------


class DriverOut(BaseModel):
    key: str
    finger: str
    metric: str
    label: str
    detail: str
    value: float
    reference: float
    z: float
    share: float  # share of the attempt's total deviation, 0-1


class FingerOut(BaseModel):
    finger: str
    badness: float
    peak_curl: Optional[float] = None
    leak: Optional[float] = None
    latency_ms: Optional[float] = None
    clean_rate: Optional[float] = None
    values: dict[str, float] = {}  # every per-finger metric of the game, by name


class ReferenceOut(BaseModel):
    source: str  # "idealized" | "prior"
    attempts: int


class FeatureDelta(BaseModel):
    key: str
    label: str
    finger: str
    before: float
    after: float
    better: bool
    magnitude: float  # |change| in reference-std units


class PreviousOut(BaseModel):
    attempt_id: int
    accuracy: Optional[float]
    score: Optional[float]
    deviation_score: Optional[float]
    accuracy_delta: Optional[float]
    score_delta: Optional[float]
    deviation_delta: Optional[float]
    improved: list[FeatureDelta]
    regressed: list[FeatureDelta]


class TrendOut(BaseModel):
    attempts: int
    direction: str
    accuracy_level: Optional[float]
    accuracy_slope: Optional[float]
    deviation_level: Optional[float]
    volatility: float
    best_accuracy: Optional[float]
    accuracy_series: list[float]
    deviation_series: list[float]


class ChangeOut(BaseModel):
    key: str
    label: str
    from_value: Any
    to_value: Any
    direction: str
    reason: str


class AdaptationOut(BaseModel):
    verdict: str
    rationale: str
    confidence: float
    quality: Optional[float]
    focus_finger: Optional[str]
    current_params: dict[str, Any]
    next_params: dict[str, Any]
    changes: list[ChangeOut]


class AnalysisOut(BaseModel):
    attempt_id: Optional[int]
    exercise_id: str
    accuracy: Optional[float]
    deviation_score: Optional[float]
    detection_rate: Optional[float]
    features: dict[str, float]
    reference: ReferenceOut
    drivers: list[DriverOut]
    fingers: list[FingerOut]
    previous: Optional[PreviousOut]
    trend: TrendOut
    adaptation: Optional[AdaptationOut]


# ---- data access ------------------------------------------------------------


def ensure_features(session: Session, attempts: list[Attempt]) -> None:
    """Computes (and stores) features for attempts that predate extraction."""
    dirty = False
    for a in attempts:
        if not a.features:
            a.features = spec_for(a.exercise_id).extract(a.frames, a.meta or {})
            session.add(a)
            dirty = True
    if dirty:
        session.commit()


def reference_profile(session: Session, exercise_id: str, exclude_id: Optional[int] = None) -> ReferenceProfile:
    refs = session.exec(
        select(Attempt)
        .where(Attempt.exercise_id == exercise_id, Attempt.is_idealized == True)  # noqa: E712
        .order_by(Attempt.created_at.desc())
        .limit(REFERENCE_LIMIT)
    ).all()
    refs = [r for r in refs if r.id != exclude_id]
    ensure_features(session, refs)
    return build_profile([r.features for r in refs if r.features], spec_for(exercise_id).metrics)


def _accuracy(meta: dict[str, Any]) -> Optional[float]:
    vals = [meta.get(k) for k in ("hits", "leaks", "misses")]
    if not all(isinstance(v, (int, float)) for v in vals):
        return None
    total = sum(vals)
    return vals[0] / total if total else None


def _history(
    session: Session, patient_id: Optional[uuid.UUID], exercise_id: str, before: Optional[datetime], exclude_id: Optional[int]
) -> list[Attempt]:
    """The patient's earlier attempts, oldest first."""
    if patient_id is None:
        return []
    q = select(Attempt).where(
        Attempt.patient_id == patient_id, Attempt.exercise_id == exercise_id, Attempt.is_idealized == False  # noqa: E712
    )
    if before is not None:
        q = q.where(Attempt.created_at < before)
    rows = session.exec(q.order_by(Attempt.created_at.desc()).limit(HISTORY_LIMIT)).all()
    rows = [r for r in rows if r.id != exclude_id]
    ensure_features(session, rows)
    return list(reversed(rows))


# ---- the pipeline -----------------------------------------------------------


def _drivers(dev: Deviation, metrics, limit: int = 4) -> list[DriverOut]:
    return [
        DriverOut(
            key=i.key, finger=i.finger, metric=i.metric, label=metrics[i.metric].label, detail=describe(i, metrics),
            value=round(i.value, 3), reference=round(i.ref_mean, 3), z=round(i.z, 2), share=round(i.share, 3),
        )
        for i in dev.items
        if i.badness >= 0.5
    ][:limit]


def _fingers(features: dict[str, float], dev: Deviation, metrics) -> list[FingerOut]:
    per_finger = [n for n, m in metrics.items() if m.per_finger]
    return [
        FingerOut(
            finger=f,
            badness=round(dev.finger_badness[f], 2),
            values={m: features[f"{f}.{m}"] for m in per_finger if f"{f}.{m}" in features},
            **{m: features.get(f"{f}.{m}") for m in ("peak_curl", "leak", "latency_ms", "clean_rate")},
        )
        for f in FINGERS
        if f in dev.finger_badness
    ]


def _compare(
    prev: Attempt, features: dict[str, float], meta: dict[str, Any], dev: Deviation, profile: ReferenceProfile
) -> PreviousOut:
    metrics = profile.metrics
    pmeta = prev.meta or {}
    pdev = deviation(prev.features or {}, profile)
    pacc, acc = _accuracy(pmeta), _accuracy(meta)
    pscore, score = pmeta.get("score"), meta.get("score")
    deltas: list[FeatureDelta] = []
    for f in FINGERS:
        for m in (n for n, mt in metrics.items() if mt.per_finger):
            key = f"{f}.{m}"
            if key in features and key in (prev.features or {}):
                st = profile.stats[key]
                before, after = prev.features[key], features[key]
                better = st.polarity * (after - before) > 0
                deltas.append(
                    FeatureDelta(
                        key=key, label=f"{f.capitalize()} {metrics[m].label}", finger=f,
                        before=round(before, 3), after=round(after, 3), better=better,
                        magnitude=round(abs(after - before) / st.std, 2),
                    )
                )
    meaningful = [d for d in deltas if d.magnitude >= 0.5]
    meaningful.sort(key=lambda d: d.magnitude, reverse=True)
    return PreviousOut(
        attempt_id=prev.id or 0,
        accuracy=None if pacc is None else round(pacc, 3),
        score=pscore if isinstance(pscore, (int, float)) else None,
        deviation_score=pdev.score if pdev.items else None,
        accuracy_delta=None if pacc is None or acc is None else round(acc - pacc, 3),
        score_delta=score - pscore if isinstance(score, (int, float)) and isinstance(pscore, (int, float)) else None,
        deviation_delta=round(dev.score - pdev.score, 1) if dev.items and pdev.items else None,
        improved=[d for d in meaningful if d.better][:3],
        regressed=[d for d in meaningful if not d.better][:3],
    )


def _adaptation(a: Adaptation, current: dict[str, Any], labels: dict[str, str]) -> AdaptationOut:
    return AdaptationOut(
        verdict=a.verdict,
        rationale=a.rationale,
        confidence=a.confidence,
        quality=a.quality,
        focus_finger=a.focus_finger,
        current_params=current,
        next_params=a.next_params,
        changes=[
            ChangeOut(
                key=c.key, label=labels.get(c.key, c.key), from_value=c.from_, to_value=c.to,
                direction=c.direction, reason=c.reason,
            )
            for c in a.changes
        ],
    )


def analyze(
    session: Session,
    *,
    exercise_id: str,
    frames: Optional[list[dict[str, Any]]],
    meta: dict[str, Any],
    features: Optional[dict[str, float]] = None,
    patient_id: Optional[uuid.UUID] = None,
    attempt_id: Optional[int] = None,
    created_at: Optional[datetime] = None,
    idealized: bool = False,
) -> AnalysisOut:
    spec = spec_for(exercise_id)
    features = features or spec.extract(frames or [], meta)
    profile = reference_profile(session, exercise_id, exclude_id=attempt_id if idealized else None)
    dev = deviation(features, profile)

    hist = _history(session, patient_id, exercise_id, created_at, attempt_id)
    acc_hist = [a for a in (_accuracy(h.meta or {}) for h in hist) if a is not None]
    dev_hist = [d.score / 100 for d in (deviation(h.features or {}, profile) for h in hist) if d.items]
    acc = _accuracy(meta)
    acc_series = acc_hist + ([acc] if acc is not None else [])
    dev_series = dev_hist + ([dev.score / 100] if dev.items else [])
    trend = analyze_trend(acc_series)

    previous = _compare(hist[-1], features, meta, dev, profile) if hist and dev.items else None

    adaptation = None
    if spec.adapt is not None and acc_series:
        current = spec.normalize_params(meta.get("params"))
        stats = {k: int(meta.get(k) or 0) for k in ("hits", "leaks", "misses")}
        adaptation = _adaptation(
            spec.adapt(current, stats=stats, accuracy_series=acc_series, trend=trend, dev=dev), current, spec.param_labels or {}
        )

    return AnalysisOut(
        attempt_id=attempt_id,
        exercise_id=exercise_id,
        accuracy=None if acc is None else round(acc, 3),
        deviation_score=dev.score if dev.items else None,
        detection_rate=features.get("all.detection_rate"),
        features=features,
        reference=ReferenceOut(source=profile.source, attempts=profile.n_attempts),
        drivers=_drivers(dev, spec.metrics),
        fingers=_fingers(features, dev, spec.metrics),
        previous=previous,
        trend=TrendOut(
            attempts=trend.n,
            direction=trend.direction,
            accuracy_level=None if trend.level is None else round(trend.level, 3),
            accuracy_slope=None if trend.slope is None else round(trend.slope, 4),
            deviation_level=None if not dev_series else round(sum(dev_series) / len(dev_series), 3),
            volatility=round(trend.volatility, 3),
            best_accuracy=None if trend.best is None else round(trend.best, 3),
            accuracy_series=[round(v, 3) for v in acc_series],
            deviation_series=[round(v, 3) for v in dev_series],
        ),
        adaptation=adaptation,
    )


def analyze_attempt(session: Session, attempt: Attempt) -> AnalysisOut:
    ensure_features(session, [attempt])
    return analyze(
        session,
        exercise_id=attempt.exercise_id,
        frames=None,
        meta=attempt.meta or {},
        features=attempt.features,
        patient_id=attempt.patient_id,
        attempt_id=attempt.id,
        created_at=attempt.created_at,
        idealized=attempt.is_idealized,
    )


def next_params_for(session: Session, patient_id: uuid.UUID, exercise_id: str) -> Optional[AnalysisOut]:
    """Analysis of the patient's most recent attempt: its `adaptation.next_params` start the next one."""
    last = session.exec(
        select(Attempt)
        .where(Attempt.patient_id == patient_id, Attempt.exercise_id == exercise_id, Attempt.is_idealized == False)  # noqa: E712
        .order_by(Attempt.created_at.desc())
        .limit(1)
    ).first()
    return analyze_attempt(session, last) if last else None
