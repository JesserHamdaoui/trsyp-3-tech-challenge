"""Pinch Flight: features from glove-style frames, deviation from the reference, adaptation.

Runs under pytest or as a plain script (`python tests/test_pinch.py`).
"""

import math
import random
import sys

import uuid

from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlmodel import Session, SQLModel, create_engine

from engine.analysis import analyze_attempt
from engine.features.pinch import PINCH_FINGERS, extract_features
from engine.storage.models import Attempt, Exercise, Profile, UserRole


@compiles(JSONB, "sqlite")
def _jsonb(type_, compiler, **kw):
    return "JSON"


def setup(exercise_id):
    s = Session(create_engine("sqlite://"))
    SQLModel.metadata.create_all(s.get_bind())
    pid = uuid.uuid4()
    s.add(Profile(id=pid, email="p@x.io", role=UserRole.patient))
    s.add(Exercise(exercise_id=exercise_id, display_name="Pinch Flight", description=""))
    s.commit()
    return s, pid


def store(s, frames, meta, pid=None, idealized=False, exercise=None):
    a = Attempt(exercise_id=exercise, patient_id=None if idealized else pid, is_idealized=idealized, frames=frames, meta=meta,
                features=extract_features(frames, meta))
    s.add(a)
    s.commit()
    s.refresh(a)
    return a

EX = "pinch_flight"
PARAMS = {"forceLow": 0.25, "forceHigh": 0.6, "bandWidth": 0.26, "holdMs": 1400, "restMs": 1200, "scrollMs": 3400,
          "dynamicMix": 0.15, "birdAssist": 0.5, "isolationTolerance": 0.35, "pipeCount": 12}


def make_round(rng, *, noise=0.01, tremor_g=0.01, lag_ms=120, bias=0.0, weak=None, weak_bias=-0.25, leak=0.05, n_pipes=12, fps=30):
    """Frames with glove packets + meta.pipes for a simulated round. `weak` undershoots its band and wobbles."""
    pipes, t = [], 3000.0
    for i in range(n_pipes):
        finger = rng.choice(PINCH_FINGERS)
        if weak and i % 3 == 0:
            finger = weak
        c = rng.uniform(0.3, 0.6)
        pipes.append({"finger": finger, "start_ms": t, "end_ms": t + 1400, "kind": "static", "c0": c, "c1": c, "band": 0.26})
        t += 1400 + 1200
    end = t + 1000
    frames, ts = [], 3000.0 - 500
    force = {f: 0.0 for f in ("thumb", *PINCH_FINGERS)}
    while ts < end:
        active = next((p for p in pipes if p["start_ms"] - 300 <= ts <= p["end_ms"]), None)
        target = {f: 0.0 for f in force}
        if active:
            f = active["finger"]
            off = weak_bias if f == weak else bias
            target[f] = max(0.0, active["c0"] + off)
            for o in PINCH_FINGERS:
                if o != f:
                    target[o] = leak
        a = 1 - math.exp(-(1000 / fps) / lag_ms)
        for f in force:
            w = noise * (3 if f == weak else 1)
            force[f] += a * (target[f] - force[f]) + rng.gauss(0, w)
            force[f] = min(1.0, max(0.0, force[f]))
        ph = ts / 1000 * 2 * math.pi * 6.5
        imu = {"ax": tremor_g * math.sin(ph) + rng.gauss(0, 0.002), "ay": tremor_g * math.cos(ph), "az": rng.gauss(0, 0.002),
               "gx": 0.0, "gy": 0.0, "gz": 0.0}
        frames.append({"timestamp_ms": round(ts), "hand_detected": True,
                       "glove": {"t": round(ts), "fsr": {}, "force": dict(force), "imu": imu}})
        ts += 1000 / fps
    hits = leaks = misses = 0
    for p in pipes:
        rows = [f["glove"]["force"][p["finger"]] for f in frames if p["start_ms"] <= f["timestamp_ms"] <= p["end_ms"]]
        inband = sum(1 for v in rows if abs(v - p["c0"]) <= 0.13) / len(rows)
        others = max(max(f["glove"]["force"][o] for o in PINCH_FINGERS if o != p["finger"]) for f in frames
                     if p["start_ms"] <= f["timestamp_ms"] <= p["end_ms"])
        p["result"] = "miss" if inband < 0.8 else "leak" if others > 0.35 else "hit"
        hits += p["result"] == "hit"; leaks += p["result"] == "leak"; misses += p["result"] == "miss"
    meta = {"hits": hits, "leaks": leaks, "misses": misses, "score": hits * 100, "params": PARAMS, "pipes": pipes}
    return frames, meta


def test_features_see_control_quality():
    rng = random.Random(3)
    good = extract_features(*make_round(rng))
    shaky = extract_features(*make_round(rng, noise=0.05, tremor_g=0.12, lag_ms=400))
    assert good["all.force_error"] < shaky["all.force_error"]
    assert good["all.wobble"] < shaky["all.wobble"]
    assert shaky["all.tremor"] > good["all.tremor"] * 3
    assert good["all.latency_ms"] < shaky["all.latency_ms"]
    assert "index.clean_rate" in good or "middle.clean_rate" in good
    print("ok test_features_see_control_quality")


def test_reference_adapts_and_names_weak_finger():
    rng = random.Random(4)
    s, pid = setup(EX)
    for _ in range(3):
        store(s, *make_round(rng), idealized=True, exercise=EX)
    good = store(s, *make_round(rng, noise=0.012), pid=pid, exercise=EX)
    a = analyze_attempt(s, good)
    assert a.reference.source == "idealized" and a.reference.attempts == 3
    assert a.deviation_score > 60, a.deviation_score
    assert a.adaptation and a.adaptation.verdict == "harder", (a.adaptation.verdict, a.accuracy, a.deviation_score)
    assert a.adaptation.next_params["bandWidth"] < PARAMS["bandWidth"] or a.adaptation.next_params["holdMs"] > PARAMS["holdMs"]

    weak = store(s, *make_round(rng, weak="ring", n_pipes=18), pid=pid, exercise=EX)
    b = analyze_attempt(s, weak)
    assert max(b.fingers, key=lambda f: f.badness).finger == "ring", [(f.finger, f.badness) for f in b.fingers]
    assert b.deviation_score < a.deviation_score
    assert b.adaptation.focus_finger == "ring"
    assert b.adaptation.next_params["focusBoost"] >= 0.15
    print("ok test_reference_adapts_and_names_weak_finger")


def test_shaky_hand_gets_steadying_help():
    rng = random.Random(5)
    s, pid = setup(EX)
    for _ in range(3):
        store(s, *make_round(rng), idealized=True, exercise=EX)
    for _ in range(2):
        shaky = store(s, *make_round(rng, noise=0.07, tremor_g=0.15, lag_ms=380, bias=-0.1), pid=pid, exercise=EX)
    r = analyze_attempt(s, shaky)
    assert r.adaptation.verdict == "easier", (r.adaptation.verdict, r.accuracy)
    nxt, cur = r.adaptation.next_params, PARAMS
    assert nxt["bandWidth"] > cur["bandWidth"] or nxt["birdAssist"] > cur["birdAssist"]
    assert sum(1 for c in r.adaptation.changes if c.key != "focusFinger") <= 3
    print("ok test_shaky_hand_gets_steadying_help", [(c.key, c.to_value) for c in r.adaptation.changes])


if __name__ == "__main__":
    test_features_see_control_quality()
    test_reference_adapts_and_names_weak_finger()
    test_shaky_hand_gets_steadying_help()
