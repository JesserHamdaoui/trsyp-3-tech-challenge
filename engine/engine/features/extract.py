"""
Per-attempt feature extraction for finger-press games (Piano Press today).

Input is the raw frame list (docs/frame-schema.md) plus the game's `meta`.
When `meta.notes` is present -- one entry per judged note,
`{finger, hit_at_ms, result}` on the same clock as the frames' `timestamp_ms`
-- every note is measured on its own window of frames. Older/seeded attempts
that only carry `meta.target_finger` are measured as one big note.

Output is a flat `dict[str, float]` (what `Attempt.features` stores):

    <finger>.peak_curl     mean peak curl of the pressed finger          (0-1, higher better)
    <finger>.leak          mean peak curl of the *other* fingers while it
                           was pressed, ring/pinky coupling excluded      (0-1, lower better)
    <finger>.latency_ms    mean |time to cross the curl threshold - the
                           moment the note reached the line|              (ms, lower better)
    <finger>.smoothness    mean movement_smoothness_score                 (0-1, higher better)
    <finger>.clean_rate    notes judged "hit" / notes for that finger     (0-1, higher better)
    all.<metric>           the same, pooled over every note
    all.latency_bias_ms    signed latency (negative = early); informational
    all.detection_rate     share of frames with a hand
"""

from statistics import fmean
from typing import Any, Optional

FINGERS = ("thumb", "index", "middle", "ring", "pinky")
COUPLED = {"ring": "pinky", "pinky": "ring"}  # anatomically coupled, ignored for leak
METRICS = ("peak_curl", "leak", "latency_ms", "smoothness", "clean_rate")

DEFAULT_THRESHOLD = 0.65
DEFAULT_WINDOW_MS = 350
WINDOW_PAD_MS = 200  # look a little beyond the judging window


def _curl(frame: dict[str, Any], finger: str) -> Optional[float]:
    try:
        v = frame["fingers"][finger]["curl_normalized"]
    except (KeyError, TypeError):
        return None
    return float(v) if isinstance(v, (int, float)) else None


def _smooth(frame: dict[str, Any], finger: str) -> Optional[float]:
    try:
        v = frame["fingers"][finger]["movement_smoothness_score"]
    except (KeyError, TypeError):
        return None
    return float(v) if isinstance(v, (int, float)) else None


def _ts(frame: dict[str, Any]) -> Optional[float]:
    v = frame.get("timestamp_ms")
    return float(v) if isinstance(v, (int, float)) else None


def _measure_note(
    frames: list[dict[str, Any]], finger: str, lo: float, hi: float, threshold: float, hit_at: Optional[float]
) -> Optional[dict[str, Optional[float]]]:
    """Measures one press inside [lo, hi] ms; None when the hand was barely visible."""
    window = [f for f in frames if f.get("hand_detected") and (t := _ts(f)) is not None and lo <= t <= hi]
    series = [(_ts(f), c) for f in window if (c := _curl(f, finger)) is not None]
    if len(series) < 2:
        return None

    peak = max(c for _, c in series)
    pressed = [f for f in window if (c := _curl(f, finger)) is not None and c >= threshold]
    if not pressed:  # never pressed: judge isolation at the peak frame so there is still a number
        pressed = [max(window, key=lambda f: _curl(f, finger) or 0.0)]
    skip = {finger, COUPLED.get(finger)}
    others = [c for f in pressed for n in FINGERS if n not in skip and (c := _curl(f, n)) is not None]
    leak = max(others) if others else None

    latency = None
    if hit_at is not None:
        cross = next((t for t, c in series if c >= threshold), None)
        if cross is not None:
            latency = cross - hit_at

    smooth = [s for f in window if (s := _smooth(f, finger)) is not None]
    return {
        "peak_curl": peak,
        "leak": leak,
        "latency": latency,
        "smoothness": fmean(smooth) if smooth else None,
    }


def _agg(values: list[Optional[float]]) -> Optional[float]:
    vals = [v for v in values if v is not None]
    return fmean(vals) if vals else None


def extract_features(frames: list[dict[str, Any]], meta: dict[str, Any]) -> dict[str, float]:
    params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
    threshold = float(params.get("targetCurlThreshold", DEFAULT_THRESHOLD))
    window_ms = float(params.get("timingWindowMs", DEFAULT_WINDOW_MS)) + WINDOW_PAD_MS

    out: dict[str, float] = {}
    if frames:
        out["all.detection_rate"] = round(sum(1 for f in frames if f.get("hand_detected")) / len(frames), 3)

    # (finger, measurement-or-None, result)
    measured: list[tuple[str, Optional[dict[str, Optional[float]]], Optional[str]]] = []
    notes = meta.get("notes")
    if isinstance(notes, list) and notes:
        for n in notes:
            finger = str(n.get("finger", "")).lower()
            hit_at = n.get("hit_at_ms")
            if finger not in FINGERS or not isinstance(hit_at, (int, float)):
                continue
            m = _measure_note(frames, finger, hit_at - window_ms, hit_at + window_ms, threshold, float(hit_at))
            measured.append((finger, m, n.get("result")))
    else:
        target = meta.get("target_finger")
        if isinstance(target, str) and target.lower() in FINGERS:
            stamps = [t for f in frames if (t := _ts(f)) is not None]
            if stamps:
                m = _measure_note(frames, target.lower(), min(stamps), max(stamps), threshold, None)
                measured.append((target.lower(), m, None))

    pooled: dict[str, list[Optional[float]]] = {k: [] for k in ("peak_curl", "leak", "latency", "smoothness")}
    signed: list[float] = []
    results: list[Optional[bool]] = []

    for finger in FINGERS:
        mine = [(m, r) for f, m, r in measured if f == finger]
        if not mine:
            continue
        obs = [m for m, _ in mine if m is not None]
        for key, name in (("peak_curl", "peak_curl"), ("leak", "leak"), ("smoothness", "smoothness")):
            v = _agg([m[key] for m in obs])
            if v is not None:
                out[f"{finger}.{name}"] = round(v, 3)
        lat = [m["latency"] for m in obs if m["latency"] is not None]
        if lat:
            out[f"{finger}.latency_ms"] = round(fmean(abs(x) for x in lat), 1)
        graded = [r for _, r in mine if r in ("hit", "leak", "miss")]
        if graded:
            out[f"{finger}.clean_rate"] = round(sum(1 for r in graded if r == "hit") / len(graded), 3)
        for m in obs:
            for k in pooled:
                pooled[k].append(m[k])
        signed += [x for x in lat]
        results += [r == "hit" for r in (r for _, r in mine) if r in ("hit", "leak", "miss")]

    for key, name in (("peak_curl", "peak_curl"), ("leak", "leak"), ("smoothness", "smoothness")):
        v = _agg(pooled[key])
        if v is not None:
            out[f"all.{name}"] = round(v, 3)
    if signed:
        out["all.latency_ms"] = round(fmean(abs(x) for x in signed), 1)
        out["all.latency_bias_ms"] = round(fmean(signed), 1)
    if results:
        out["all.clean_rate"] = round(sum(results) / len(results), 3)
    return out
