"""
Recording-quality checks for an attempt's frames. Not scoring against a
reference (that's a later pipeline stage) -- this answers "is this recording
usable at all, and does it show the movement it claims to?", which is what an
admin needs before trusting an upload as a reference.

Frame fields read (see docs/frame-schema.md): hand_detected, timestamp_ms,
fingers.<name>.curl_normalized. Everything is read defensively, since the
engine does not validate frame schemas.
"""

from typing import Any, Literal, Optional

from pydantic import BaseModel

# same thresholds the Piano Press game judges with (interface/src/lib/pianoGame.ts)
TARGET_CURL_THRESHOLD = 0.65
ISOLATION_TOLERANCE = 0.35
MIN_DETECTION_RATE = 0.8
MIN_FRAMES = 10
MIN_FPS = 15

# ring and pinky are anatomically coupled; the game ignores them for leak checks
_COUPLED = {"ring": "pinky", "pinky": "ring"}

Verdict = Literal["good", "review", "poor"]


class QualityReport(BaseModel):
    verdict: Verdict
    issues: list[str]
    frame_count: int
    detected_frames: int
    detection_rate: float
    duration_ms: Optional[int]
    fps: Optional[float]
    target_finger: Optional[str]
    target_peak_curl: Optional[float]
    isolation_peak: Optional[float]
    accuracy: Optional[float]


def _curl(frame: dict[str, Any], finger: str) -> Optional[float]:
    try:
        value = frame["fingers"][finger]["curl_normalized"]
    except (KeyError, TypeError):
        return None
    return float(value) if isinstance(value, (int, float)) else None


def analyze(frames: list[dict[str, Any]], meta: dict[str, Any]) -> QualityReport:
    total = len(frames)
    detected = [f for f in frames if f.get("hand_detected")]
    rate = len(detected) / total if total else 0.0

    stamps = [f["timestamp_ms"] for f in frames if isinstance(f.get("timestamp_ms"), (int, float))]
    duration_ms = int(max(stamps) - min(stamps)) if len(stamps) > 1 else None
    fps = round(total / (duration_ms / 1000), 1) if duration_ms else None

    target = meta.get("target_finger")
    target = target.lower() if isinstance(target, str) else None
    target_peak = isolation_peak = None
    if target and detected:
        scored = [(c, f) for f in detected if (c := _curl(f, target)) is not None]
        if scored:
            target_peak = max(c for c, _ in scored)
            pressed = [f for c, f in scored if c >= TARGET_CURL_THRESHOLD]
            # judge isolation while the target is actually pressed; if it never
            # was, fall back to the peak frame so there's still a number
            window = pressed or [max(scored, key=lambda cf: cf[0])[1]]
            others = [
                c
                for f in window
                for name in ("thumb", "index", "middle", "ring", "pinky")
                if name != target and name != _COUPLED.get(target)
                if (c := _curl(f, name)) is not None
            ]
            isolation_peak = max(others) if others else None

    accuracy = None
    hits, leaks, misses = (meta.get(k) for k in ("hits", "leaks", "misses"))
    if all(isinstance(v, int) for v in (hits, leaks, misses)) and hits + leaks + misses:
        accuracy = round(hits / (hits + leaks + misses), 3)

    poor: list[str] = []
    review: list[str] = []
    if total < MIN_FRAMES:
        poor.append(f"Only {total} frames recorded")
    if total and rate < MIN_DETECTION_RATE:
        poor.append(f"Hand detected in only {rate:.0%} of frames")
    if target_peak is not None and target_peak < TARGET_CURL_THRESHOLD:
        poor.append(f"{target.capitalize()} never curled past {TARGET_CURL_THRESHOLD:.0%} (peak {target_peak:.0%})")
    if isolation_peak is not None and isolation_peak > ISOLATION_TOLERANCE:
        review.append(f"Other fingers moved while pressing (peak {isolation_peak:.0%})")
    if fps is not None and fps < MIN_FPS:
        review.append(f"Low frame rate ({fps:g} fps)")
    if accuracy is not None and accuracy < 0.7:
        review.append(f"Only {accuracy:.0%} of notes were clean hits")

    verdict: Verdict = "poor" if poor else "review" if review else "good"
    return QualityReport(
        verdict=verdict,
        issues=poor + review,
        frame_count=total,
        detected_frames=len(detected),
        detection_rate=round(rate, 3),
        duration_ms=duration_ms,
        fps=fps,
        target_finger=target,
        target_peak_curl=round(target_peak, 3) if target_peak is not None else None,
        isolation_peak=round(isolation_peak, 3) if isolation_peak is not None else None,
        accuracy=accuracy,
    )
