"""
What the engine knows about each game: the features it measures, how they are judged against the
idealized reference, and how its difficulty adapts. Everything else (storage, history, trend,
comparison, API) is game-agnostic. An exercise without a spec gets Piano Press's features and no
adaptation, which is what the seeded `fist_close` style recordings need.
"""

from dataclasses import dataclass
from typing import Any, Callable, Optional

from engine.adapt import piano as piano_adapt
from engine.adapt import pinch as pinch_adapt
from engine.features import extract as piano_features
from engine.features import pinch as pinch_features
from engine.scoring.reference import PIANO_METRICS, Metric

PINCH_METRICS: dict[str, Metric] = {
    "force_error": Metric(0.07, 0.05, -1, "force control", unit="pct"),
    "overshoot": Metric(0.05, 0.05, -1, "overshoot", unit="pct"),
    "latency_ms": Metric(450.0, 250.0, -1, "time to reach the force", unit="ms"),
    "wobble": Metric(0.03, 0.025, -1, "hold steadiness", unit="pct"),
    "leak": Metric(0.1, 0.08, -1, "finger isolation", unit="pct"),
    "clean_rate": Metric(0.9, 0.1, +1, "clean gates", unit="pct"),
    # hand-level, from the palm IMU: new sensor, so they count for less until a reference exists
    "tremor": Metric(0.03, 0.03, -1, "tremor", weight=0.5, per_finger=False, unit="mg"),
    "jerk": Metric(4.0, 4.0, -1, "jerkiness", weight=0.4, per_finger=False),
}


@dataclass(frozen=True)
class GameSpec:
    exercise_id: str
    metrics: dict[str, Metric]
    extract: Callable[[list[dict[str, Any]], dict[str, Any]], dict[str, float]]
    normalize_params: Callable[[Any], dict[str, Any]]
    adapt: Optional[Callable[..., Any]] = None
    param_labels: Optional[dict[str, str]] = None


PIANO = GameSpec(
    "piano_isolated_press",
    PIANO_METRICS,
    piano_features.extract_features,
    piano_adapt.normalize_params,
    piano_adapt.adapt,
    {
        "targetCurlThreshold": "Curl needed",
        "isolationTolerance": "Other-finger allowance",
        "timingWindowMs": "Timing window",
        "noteFallMs": "Note fall time",
        "sequenceLength": "Notes per round",
        "focusFinger": "Focus finger",
    },
)
PINCH = GameSpec(
    "pinch_flight",
    PINCH_METRICS,
    pinch_features.extract_features,
    pinch_adapt.normalize_params,
    pinch_adapt.adapt,
    pinch_adapt.PARAM_LABELS,
)
# no adaptation, Piano Press's measurements
GENERIC = GameSpec("*", PIANO_METRICS, piano_features.extract_features, piano_adapt.normalize_params)

SPECS = {s.exercise_id: s for s in (PIANO, PINCH)}


def spec_for(exercise_id: str) -> GameSpec:
    return SPECS.get(exercise_id, GENERIC)
