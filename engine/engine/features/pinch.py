"""
Per-attempt feature extraction for Pinch Flight (force-matching with a sensor glove).

Input is the frame list plus the game's `meta`. Every frame may carry the glove's
latest packet (see docs/pinch-game.md, "Glove packet"):

    frame["glove"] = {
        "t": ms on the frames' clock,
        "fsr":   {finger: raw sensor value},          # not used here
        "force": {finger: 0-1, calibrated to the patient's own range},
        "imu":   {"ax","ay","az": g, "gx","gy","gz": deg/s},
    }

and `meta.pipes` holds one entry per pipe the patient flew through:

    {finger, start_ms, end_ms, kind: static|step|ramp, c0, c1, band, result}

`band` is the full width of the target band, `c0`/`c1` the band's centre at the
start/end of the pipe (equal for a static pipe), all as fractions of the range.

Output is a flat `dict[str, float]` like Piano Press's:

    <finger>.force_error   RMS distance from the band centre while the pipe was active
    <finger>.overshoot     worst excursion above the band while reaching it
    <finger>.latency_ms    time from the pipe's start until the force first entered the band
    <finger>.wobble        high-frequency force noise while holding (steadiness)
    <finger>.leak          peak force of the *other* fingers (ring/pinky coupling excluded)
    <finger>.clean_rate    pipes judged "hit" / pipes for that finger
    all.<metric>           the same, pooled over every pipe
    all.tremor             RMS of the 4-12 Hz palm acceleration (g) while holding
    all.jerk               RMS rate of change of palm acceleration (g/s) while holding
    all.detection_rate     share of frames with a hand
"""

from math import cos, pi, sin, sqrt
from statistics import fmean, pstdev
from typing import Any, Optional

FINGERS = ("thumb", "index", "middle", "ring", "pinky")
PINCH_FINGERS = ("index", "middle", "ring", "pinky")
COUPLED = {"ring": "pinky", "pinky": "ring"}
TREMOR_BAND_HZ = (4.0, 12.0)
WOBBLE_WINDOW_MS = 400.0
DEFAULT_BAND = 0.24


def centre_at(pipe: dict[str, Any], u: float) -> float:
    """Where the band's centre is, `u` in 0-1 through the pipe."""
    c0 = float(pipe.get("c0", 0.4))
    c1 = float(pipe.get("c1", c0))
    kind = pipe.get("kind", "static")
    if kind == "ramp":
        return c0 + (c1 - c0) * u
    if kind == "step":
        return c0 if u < 0.5 else c1
    return c0


def _ts(frame: dict[str, Any]) -> Optional[float]:
    v = frame.get("timestamp_ms")
    return float(v) if isinstance(v, (int, float)) else None


def _forces(frame: dict[str, Any]) -> Optional[dict[str, float]]:
    g = frame.get("glove")
    f = g.get("force") if isinstance(g, dict) else None
    return f if isinstance(f, dict) else None


def _imu(frame: dict[str, Any]) -> Optional[tuple[float, float, float]]:
    g = frame.get("glove")
    i = g.get("imu") if isinstance(g, dict) else None
    try:
        return float(i["ax"]), float(i["ay"]), float(i["az"])
    except (KeyError, TypeError, ValueError):
        return None


def _band_rms(ts: list[float], xs: list[float]) -> float:
    """RMS of the TREMOR_BAND_HZ component of an unevenly sampled signal (projection on sines, 1 Hz steps)."""
    n = len(xs)
    if n < 8:
        return 0.0
    mean = fmean(xs)
    xs = [x - mean for x in xs]
    t0 = ts[0]
    power = 0.0
    for k in range(int(TREMOR_BAND_HZ[0]), int(TREMOR_BAND_HZ[1]) + 1):
        w = 2 * pi * k
        a = sum(x * cos(w * (t - t0) / 1000.0) for t, x in zip(ts, xs))
        b = sum(x * sin(w * (t - t0) / 1000.0) for t, x in zip(ts, xs))
        amp = 2.0 / n * sqrt(a * a + b * b)
        power += amp * amp / 2.0
    return sqrt(power)


def _rms(vals: list[float]) -> float:
    return sqrt(fmean(v * v for v in vals)) if vals else 0.0


def _measure_pipe(frames: list[dict[str, Any]], pipe: dict[str, Any]) -> Optional[dict[str, Any]]:
    finger = str(pipe.get("finger", "")).lower()
    start, end = pipe.get("start_ms"), pipe.get("end_ms")
    if finger not in PINCH_FINGERS or not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or end <= start:
        return None
    band = float(pipe.get("band", DEFAULT_BAND))
    dur = float(end - start)

    rows = []  # (t, force of the pipe's finger, target centre, other fingers' peak)
    skip = {finger, COUPLED.get(finger), "thumb"}
    for f in frames:
        t, force = _ts(f), _forces(f)
        if t is None or force is None or not (start <= t <= end) or finger not in force:
            continue
        others = [float(v) for k, v in force.items() if k not in skip and isinstance(v, (int, float))]
        rows.append((t, float(force[finger]), centre_at(pipe, (t - start) / dur), max(others) if others else 0.0, f))
    if len(rows) < 4:
        return None

    ts = [r[0] for r in rows]
    err = [r[1] - r[2] for r in rows]
    half = band / 2
    upper = [r[2] + half for r in rows]

    # first time in the band (a pipe the patient never reached counts as the whole pipe)
    enter = next((r[0] for r in rows if abs(r[1] - r[2]) <= half), None)
    latency = (enter - start) if enter is not None else dur

    # overshoot: how far above the band the force went during the first 40% of the pipe
    early = [r[1] - u for r, u in zip(rows, upper) if r[0] - start <= 0.4 * dur]
    overshoot = max(0.0, max(early)) if early else 0.0

    # wobble: force minus its own moving average, so a deliberate ramp is not "noise"
    resid = []
    for i, (t, v, *_rest) in enumerate(rows):
        win = [r[1] for r in rows if abs(r[0] - t) <= WOBBLE_WINDOW_MS / 2]
        resid.append(v - fmean(win))
    wobble = pstdev(resid) if len(resid) > 1 else 0.0

    # hand-level: palm acceleration while holding
    acc = [(r[0], _imu(r[4])) for r in rows]
    acc = [(t, a) for t, a in acc if a is not None]
    tremor = jerk = None
    if len(acc) >= 8:
        t_acc = [t for t, _ in acc]
        tremor = sqrt(sum(_band_rms(t_acc, [a[i] for _, a in acc]) ** 2 for i in range(3)))
        d = []
        for (t0, a0), (t1, a1) in zip(acc, acc[1:]):
            dt = (t1 - t0) / 1000.0
            if dt > 1e-3:
                d.append(sqrt(sum((a1[i] - a0[i]) ** 2 for i in range(3))) / dt)
        jerk = _rms(d) if d else None

    return {
        "finger": finger,
        "force_error": _rms(err),
        "overshoot": overshoot,
        "latency_ms": latency,
        "wobble": wobble,
        "leak": max(r[3] for r in rows),
        "clean": 1.0 if pipe.get("result") == "hit" else 0.0,
        "graded": pipe.get("result") in ("hit", "leak", "miss"),
        "tremor": tremor,
        "jerk": jerk,
    }


PER_FINGER = ("force_error", "overshoot", "latency_ms", "wobble", "leak")


def extract_features(frames: list[dict[str, Any]], meta: dict[str, Any]) -> dict[str, float]:
    out: dict[str, float] = {}
    if frames:
        out["all.detection_rate"] = round(sum(1 for f in frames if f.get("hand_detected")) / len(frames), 3)

    pipes = meta.get("pipes")
    measured = [m for p in (pipes if isinstance(pipes, list) else []) if isinstance(p, dict) and (m := _measure_pipe(frames, p))]
    if not measured:
        return out

    for finger in PINCH_FINGERS:
        mine = [m for m in measured if m["finger"] == finger]
        if not mine:
            continue
        for name in PER_FINGER:
            out[f"{finger}.{name}"] = round(fmean(m[name] for m in mine), 3 if name != "latency_ms" else 1)
        graded = [m for m in mine if m["graded"]]
        if graded:
            out[f"{finger}.clean_rate"] = round(fmean(m["clean"] for m in graded), 3)

    for name in PER_FINGER:
        out[f"all.{name}"] = round(fmean(m[name] for m in measured), 3 if name != "latency_ms" else 1)
    graded = [m for m in measured if m["graded"]]
    if graded:
        out["all.clean_rate"] = round(fmean(m["clean"] for m in graded), 3)
    for name in ("tremor", "jerk"):
        vals = [m[name] for m in measured if m[name] is not None]
        if vals:
            out[f"all.{name}"] = round(fmean(vals), 4)
    return out
