"""
Difficulty adaptation for Pinch Flight.

Same stateless design as Piano Press (adapt/piano.py): the next settings follow
from the settings the last round used plus the analysis of the recent rounds.
`adapt.common.judge` decides the direction; this module decides *which* knob.

Going harder, the engine tightens what the patient already does well (checked
per feature against the idealized reference): a narrower force band, a longer
hold, higher target forces, more moving targets, less steadying help, less
recovery time. Going easier, it eases the dimension that costs the most:
force-control errors widen the band; wobble, tremor and jerk add steadying
help; overshoot and slow reach give more lead time; leaks relax the isolation
allowance. At most three numeric settings move per round.
"""

from typing import Any, Literal, Optional

from engine.adapt.common import Adaptation, Change, focus_update, judge, summarize
from engine.scoring.reference import Deviation
from engine.trend.trend import Trend

DEFAULTS: dict[str, Any] = {
    "forceLow": 0.25,
    "forceHigh": 0.6,
    "bandWidth": 0.26,
    "holdMs": 1400,
    "restMs": 1200,
    "scrollMs": 3400,
    "dynamicMix": 0.15,
    "birdAssist": 0.5,
    "isolationTolerance": 0.35,
    "pipeCount": 12,
    "focusFinger": None,
    "focusBoost": 0.0,
}
BOUNDS = {  # (min, max, decimals)
    "forceLow": (0.1, 0.5, 2),
    "forceHigh": (0.35, 0.9, 2),
    "bandWidth": (0.1, 0.4, 2),
    "holdMs": (800, 3000, 0),
    "restMs": (600, 2200, 0),
    "scrollMs": (2200, 5200, 0),
    "dynamicMix": (0.0, 0.8, 2),
    "birdAssist": (0.0, 0.9, 2),
    "isolationTolerance": (0.2, 0.5, 2),
    "pipeCount": (8, 24, 0),
}
PARAM_LABELS = {
    "forceLow": "Lightest force",
    "forceHigh": "Hardest force",
    "bandWidth": "Target band",
    "holdMs": "Hold time",
    "restMs": "Rest between",
    "scrollMs": "Lead time",
    "dynamicMix": "Moving targets",
    "birdAssist": "Steadying help",
    "isolationTolerance": "Other-finger allowance",
    "pipeCount": "Gates per round",
    "focusFinger": "Focus finger",
}
FINGERS_IN_PLAY = {"index", "middle", "ring", "pinky"}
MAX_CHANGES = 3


def normalize_params(raw: Any) -> dict[str, Any]:
    p = dict(DEFAULTS)
    if isinstance(raw, dict):
        for k in DEFAULTS:
            if k in raw and (raw[k] is None or isinstance(raw[k], (int, float, str))):
                p[k] = raw[k]
    return p


def _clamp(key: str, v: float) -> float:
    lo, hi, d = BOUNDS[key]
    v = min(hi, max(lo, v))
    return round(v, d) if d else float(round(v))


def adapt(
    params: dict[str, Any],
    *,
    stats: dict[str, int],
    accuracy_series: list[float],
    trend: Trend,
    dev: Optional[Deviation],
) -> Adaptation:
    p = normalize_params(params)
    nxt = dict(p)
    total = stats.get("hits", 0) + stats.get("leaks", 0) + stats.get("misses", 0)
    if total == 0:
        return Adaptation("hold", nxt, rationale="No gates were judged, so the settings stay the same.", confidence=0.0)

    lv = judge(accuracy_series, trend, dev)
    verdict, step, last, level, q, n = lv.verdict, lv.step, lv.last, lv.smoothed, lv.q, lv.n
    mb = dev.metric_badness if dev else {}
    declining = trend.direction == "declining"

    changes: list[Change] = []

    def move(key: str, delta: float, direction: Literal["harder", "easier"], reason: str):
        if len([c for c in changes if c.key in BOUNDS]) >= MAX_CHANGES:
            return
        to = _clamp(key, p[key] + delta)
        if to == p[key]:
            return
        nxt[key] = to
        changes.append(Change(key, p[key], to, direction, reason))

    pct = lambda v: f"{v:.0%}"
    smoothed = f"{pct(last)} this round, {pct(level)} smoothed"
    good = lambda m, lim=0.6: mb.get(m, 0.0) < lim

    if verdict == "harder":
        why = f"Accuracy {smoothed}" + (", improving" if trend.direction == "improving" else ", steady")
        if good("force_error"):
            move("bandWidth", -0.025 * step, "harder", f"{why}: force matches the reference, so the target band narrows")
        if good("wobble"):
            move("holdMs", 150 * step, "harder", "Steady holds: gates last longer")
        if good("overshoot"):
            move("forceHigh", 0.04 * step, "harder", "Reaching the target cleanly: heavier forces are asked for")
        if good("leak"):
            move("isolationTolerance", -0.03 * step, "harder", "Finger isolation matches the reference: less leakage allowed")
        if q >= 0.88:
            move("dynamicMix", 0.1 * step, "harder", "Strong control: more ramps and steps to follow")
        if good("tremor", 0.5) and good("jerk", 0.5) and p["birdAssist"] > 0.1:
            move("birdAssist", -0.08 * step, "harder", "Hand is steady: less steadying help")
        if good("latency_ms"):
            move("scrollMs", -200 * step, "harder", "Quick to reach the force: shorter lead time")
            move("restMs", -100 * step, "harder", "Recovers fast: less rest between gates")
        if q >= 0.93:
            move("pipeCount", 2, "harder", "Near-perfect rounds: longer round for endurance")
    elif verdict == "easier":
        why = f"Accuracy {smoothed}" + (", declining" if declining else "")
        cost = {m: mb[m] for m in ("force_error", "overshoot", "latency_ms", "wobble", "leak", "tremor", "jerk") if m in mb}
        dominant = max(cost, key=lambda m: cost[m], default=None)
        names = {"force_error": "force control", "overshoot": "overshooting", "latency_ms": "reaching the target", "wobble": "steadiness",
                 "leak": "finger isolation", "tremor": "hand tremor", "jerk": "jerkiness"}
        dom_txt = f" Biggest cost: {names[dominant]}." if dominant and cost[dominant] >= 0.75 else ""
        if dominant in (None, "force_error", "wobble") or cost.get("force_error", 0) >= 0.75:
            move("bandWidth", 0.03 * step, "easier", f"{why}: a wider target band.{dom_txt}")
        if cost.get("wobble", 0) >= 0.75 or cost.get("tremor", 0) >= 0.75 or cost.get("jerk", 0) >= 0.75:
            move("birdAssist", 0.12 * step, "easier", f"The hand shakes while holding: more steadying help.{dom_txt}")
        if cost.get("overshoot", 0) >= 0.75 or cost.get("latency_ms", 0) >= 0.75:
            move("scrollMs", 300 * step, "easier", f"More lead time to get ready for each gate.{dom_txt}")
        if cost.get("overshoot", 0) >= 1.0 and p["forceHigh"] > 0.45:
            move("forceHigh", -0.04 * step, "easier", "Heavy forces overshoot: ask for a little less")
        if cost.get("leak", 0) >= 0.75:
            move("isolationTolerance", 0.04 * step, "easier", "Fingers press together: a little more allowance")
        if p["dynamicMix"] > 0.0:
            move("dynamicMix", -0.1 * step, "easier", "Fewer moving targets while control builds")
        if q < 0.4:
            move("holdMs", -200 * step, "easier", "Shorter holds")
            move("pipeCount", -2, "easier", "Shorter round to stay fresh")
    else:
        worst = max(mb, key=lambda m: mb[m], default=None)
        if worst == "leak" and mb[worst] >= 1.5:
            move("isolationTolerance", 0.03, "easier", "Fingers aren't isolating yet: a little more allowance")

    focus_update(p["focusFinger"], p["focusBoost"], dev, verdict, total, nxt, changes, fingers_ok=FINGERS_IN_PLAY)

    moved = [c for c in changes if c.key in BOUNDS]
    rationale = summarize(verdict, smoothed, len(moved), bool(changes), n)
    # keep the force range coherent
    if nxt["forceLow"] > nxt["forceHigh"] - 0.15:
        nxt["forceLow"] = round(nxt["forceHigh"] - 0.15, 2)

    return Adaptation(
        verdict=verdict,
        next_params=nxt,
        changes=changes,
        rationale=rationale,
        confidence=lv.confidence,
        quality=round(q, 3),
        focus_finger=nxt["focusFinger"],
    )
