"""Physiatrist dashboards on synthetic data (SQLite). Run: python tests/test_care.py"""

import random
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, "tests")
from test_analysis import EX, make_round, setup  # noqa: E402

from engine.api.care import my_patients, overview, patient_detail, unassign_patient  # noqa: E402
from engine.features.extract import extract_features  # noqa: E402
from engine.storage.models import Attempt, PatientExercise, PhysiatristPatient, Profile, UserRole  # noqa: E402
from engine.triage import triage  # noqa: E402


def add_patient(s, name, doc, rounds):
    pid = uuid.uuid4()
    s.add(Profile(id=pid, email=f"{name}@x.io", role=UserRole.patient, full_name=name))
    s.add(PhysiatristPatient(physiatrist_id=doc.id, patient_id=pid))
    s.add(PatientExercise(patient_id=pid, exercise_id=EX, prescribed_by_id=doc.id))
    s.commit()
    rng = random.Random(name)
    for days_ago, kw in rounds:
        frames, meta = make_round(rng, **kw)
        s.add(Attempt(exercise_id=EX, patient_id=pid, frames=frames, meta=meta, features=extract_features(frames, meta),
                      created_at=datetime.now(timezone.utc) - timedelta(days=days_ago)))
    s.commit()
    return pid


def test_triage_rules():
    now = datetime.now(timezone.utc)
    t = triage(accuracy_series=[0.9, 0.9, 0.85], last_round_at=now, rounds=3, prescriptions=1, assigned_at=now, now=now)
    assert t.status == "on_track" and not t.reasons
    t = triage(accuracy_series=[0.8, 0.8], last_round_at=now - timedelta(days=10), rounds=2, prescriptions=1, assigned_at=now, now=now)
    assert any(r.code == "inactive" for r in t.reasons)
    t = triage(accuracy_series=[0.9, 0.8, 0.6, 0.4, 0.3], last_round_at=now, rounds=5, prescriptions=1, assigned_at=now, now=now)
    assert t.status == "needs_attention" and {r.code for r in t.reasons} >= {"low_accuracy", "declining"}
    t = triage(accuracy_series=[], last_round_at=None, rounds=0, prescriptions=0, assigned_at=now, now=now)
    assert t.reasons[0].code == "no_prescription"
    t = triage(accuracy_series=[], last_round_at=None, rounds=0, prescriptions=1, assigned_at=now - timedelta(days=5), now=now)
    assert t.reasons[0].code == "not_started"


def test_dashboards():
    s, _ = setup()
    doc = Profile(id=uuid.uuid4(), email="d@x.io", role=UserRole.physiatrist, full_name="Doc")
    s.add(doc); s.commit()
    good = add_patient(s, "Gina", doc, [(d, dict(peak=0.9, leak=0.1)) for d in (6, 4, 2, 0)])
    bad = add_patient(s, "Bo", doc, [(20, dict(peak=0.9, leak=0.1)), (16, dict(peak=0.55, leak=0.5)), (12, dict(peak=0.5, leak=0.55))])
    add_patient(s, "Newt", doc, [])

    pts = {p.full_name: p for p in my_patients(doc, s)}
    assert pts["Gina"].status == "on_track" and pts["Gina"].rounds_7d == 4
    assert pts["Bo"].status == "needs_attention" and any(r.code == "inactive" for r in pts["Bo"].reasons)
    assert pts["Newt"].status == "new"

    o = overview(30, doc, s)
    assert o.patients == 3 and o.needs_attention >= 1 and o.rounds == 7
    assert o.attention[0].full_name == "Bo" and o.active_patients == 1
    assert len(o.by_day) == 30 and sum(d.attempts for d in o.by_day) == 7

    d = patient_detail(good, doc, s)
    assert len(d.attempts) == 4 and d.prescriptions[0].rounds == 4
    assert d.latest_analysis and d.latest_analysis.adaptation

    # another physiatrist can't see them
    other = Profile(id=uuid.uuid4(), email="o@x.io", role=UserRole.physiatrist)
    s.add(other); s.commit()
    try:
        patient_detail(good, other, s)
        raise AssertionError("expected 403")
    except Exception as e:
        assert getattr(e, "status_code", None) == 403

    unassign_patient(bad, doc, s)
    assert len(my_patients(doc, s)) == 2


if __name__ == "__main__":
    test_triage_rules(); print("ok triage")
    test_dashboards(); print("ok dashboards")
