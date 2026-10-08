"""End-to-end check of features -> reference deviation -> trend -> adaptation on synthetic rounds.

Runs under pytest or as a plain script (`python tests/test_analysis.py`) against in-memory SQLite.
"""

import random
import uuid

from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlmodel import Session, SQLModel, create_engine

from engine.analysis import analyze, analyze_attempt, next_params_for
from engine.features.extract import FINGERS, extract_features
from engine.storage.models import Attempt, Exercise, Profile, UserRole

EX = "piano_isolated_press"
PARAMS = {"targetCurlThreshold": 0.65, "isolationTolerance": 0.35, "timingWindowMs": 350, "noteFallMs": 1800, "sequenceLength": 12}


@compiles(JSONB, "sqlite")
def _jsonb(type_, compiler, **kw):
    return "JSON"


def make_round(rng, *, peak=0.9, leak=0.1, late_ms=60, weak=None, weak_peak=0.45, weak_leak=0.55, n_notes=12, params=None):
    """30 fps frames + meta.notes for a simulated round. `weak` is a finger that under-curls and leaks."""
    params = params or PARAMS
    frames, notes, t = [], [], 5000.0
    fingers = [rng.choice(FINGERS) for _ in range(n_notes)]
    if weak:
        fingers = [weak if i % 3 == 0 else f for i, f in enumerate(fingers)]
    hits = leaks = misses = 0
    events = []
    for f in fingers:
        hit_at = t + 1800
        p = weak_peak if f == weak else peak
        lk = weak_leak if f == weak else leak
        events.append((f, hit_at, p, lk))
        t += 1100
    end = t + 2500
    ts = 5000.0
    while ts < end:
        curls = {n: 0.05 for n in FINGERS}
        for f, hit_at, p, lk in events:
            dt = ts - (hit_at + late_ms)
            if abs(dt) < 250:
                bump = max(0.0, 1 - abs(dt) / 250)
                curls[f] = max(curls[f], 0.05 + (p - 0.05) * bump)
                for o in FINGERS:
                    if o != f:
                        curls[o] = max(curls[o], lk * bump)
        frames.append(
            {
                "timestamp_ms": round(ts), "hand_detected": True,
                "fingers": {n: {"curl_normalized": curls[n] + rng.uniform(-0.01, 0.01), "movement_smoothness_score": 0.78} for n in FINGERS},
            }
        )
        ts += 33.3
    for f, hit_at, p, lk in events:
        if p < params["targetCurlThreshold"]:
            r = "miss"; misses += 1
        elif lk > params["isolationTolerance"]:
            r = "leak"; leaks += 1
        else:
            r = "hit"; hits += 1
        notes.append({"finger": f, "hit_at_ms": hit_at, "result": r})
    meta = {"hits": hits, "leaks": leaks, "misses": misses, "score": hits * 10 + leaks * 2, "params": params, "notes": notes}
    return frames, meta


def setup():
    eng = create_engine("sqlite://")
    SQLModel.metadata.create_all(eng)
    s = Session(eng)
    pid = uuid.uuid4()
    s.add(Profile(id=pid, email="p@x.io", role=UserRole.patient))
    s.add(Exercise(exercise_id=EX, display_name="Piano", description=""))
    s.commit()
    return s, pid


def store(s, frames, meta, pid=None, idealized=False):
    a = Attempt(exercise_id=EX, patient_id=None if idealized else pid, is_idealized=idealized, frames=frames, meta=meta,
                features=extract_features(frames, meta))
    s.add(a); s.commit(); s.refresh(a)
    return a


def test_features_see_the_weak_finger():
    rng = random.Random(1)
    frames, meta = make_round(rng, weak="ring", n_notes=15)
    f = extract_features(frames, meta)
    assert f["ring.peak_curl"] < 0.6 < f["index.peak_curl"] if "index.peak_curl" in f else True
    assert f["ring.leak"] > 0.4
    late = extract_features(*make_round(rng, late_ms=250, n_notes=15))
    on_time = extract_features(*make_round(rng, late_ms=0, n_notes=15))
    assert late["all.latency_ms"] > on_time["all.latency_ms"] + 100
    assert late["all.latency_bias_ms"] > 100


def test_reference_deviation_names_weak_finger_and_adapts():
    rng = random.Random(2)
    s, pid = setup()
    for _ in range(3):
        store(s, *make_round(rng, peak=0.92, leak=0.08, late_ms=30), idealized=True)

    good = store(s, *make_round(rng, peak=0.9, leak=0.1, late_ms=50), pid=pid)
    a = analyze_attempt(s, good)
    assert a.reference.source == "idealized" and a.reference.attempts == 3
    assert a.deviation_score > 70
    assert a.adaptation.verdict == "harder"
    assert a.adaptation.next_params["noteFallMs"] < PARAMS["noteFallMs"]

    weak = store(s, *make_round(rng, weak="pinky", n_notes=18), pid=pid)
    b = analyze_attempt(s, weak)
    assert b.drivers and b.drivers[0].finger in ("pinky", "all")
    assert max(b.fingers, key=lambda f: f.badness).finger == "pinky"
    assert b.deviation_score < a.deviation_score
    assert b.previous and b.previous.deviation_delta < 0
    assert b.previous.regressed
    assert b.adaptation.focus_finger == "pinky"
    assert b.adaptation.next_params["focusBoost"] >= 0.15


def test_struggling_patient_gets_easier_targeted_settings():
    rng = random.Random(3)
    s, pid = setup()
    for _ in range(3):
        store(s, *make_round(rng, peak=0.92, leak=0.08, late_ms=30), idealized=True)
    last = None
    for _ in range(3):
        last = store(s, *make_round(rng, peak=0.55, leak=0.5, late_ms=200, n_notes=12), pid=pid)
    a = analyze_attempt(s, last)
    assert a.adaptation.verdict == "easier"
    changed = {c.key for c in a.adaptation.changes}
    assert changed & {"noteFallMs", "isolationTolerance", "timingWindowMs", "targetCurlThreshold"}
    assert len([c for c in a.adaptation.changes if c.key != "focusFinger"]) <= 3
    assert a.trend.attempts == 3
    # next-params starts from the latest attempt
    n = next_params_for(s, pid, EX)
    assert n.adaptation.next_params == a.adaptation.next_params


def test_no_reference_falls_back_to_prior_and_unsaved_analysis_works():
    rng = random.Random(4)
    s, _ = setup()
    frames, meta = make_round(rng)
    a = analyze(s, exercise_id=EX, frames=frames, meta=meta)
    assert a.reference.source == "prior"
    assert a.previous is None and a.adaptation is not None


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
