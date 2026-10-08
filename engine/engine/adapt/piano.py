"""
Difficulty adaptation for Piano Press.

Stateless: the next parameters are a function of the parameters the last round
was played with plus the analysis of the patient's recent attempts, so nothing
extra has to be stored (each attempt records `meta.params`).

How it decides
1. Level. `q` blends the smoothed accuracy (EWMA over the recent attempts, so
   one fluke round doesn't swing things) with the deviation score against the
   idealized reference. q >= 0.82 with no decline -> harder; q < 0.5, a very
   bad last round, or a decline while q < 0.65 -> easier; otherwise hold.
2. Step size shrinks when there is little history or the results are noisy and
   grows when the result is extreme.
3. Which knob. Going up, the engine tightens what the patient is already good
   at (checked per feature against the reference). Going down, it eases the
   dimension that costs the most (isolation, timing, curl depth, smoothness)
   instead of making everything easier. Holding with one glaring weakness
   gives that weakness room.
4. Focus finger. The finger that deviates most from the reference is spawned
   more often, until it no longer stands out.
At most three numeric parameters move per round so the change stays explainable.
"""

from typing import Any, Literal, Optional

from engine.adapt.common import Adaptation, Change, focus_update, judge, summarize
from engine.scoring.reference import LABELS, Deviation
from engine.trend.trend import Trend

DEFAULTS: dict[str, Any] = {
    "targetCurlThreshold": 0.65,
    "isolationTolerance": 0.35,
    "timingWindowMs": 350,
    "noteFallMs": 1800,
    "sequenceLength": 16,
    "focusFinger": None,
    "focusBoost": 0.0,
}
BOUNDS = {  # (min, max, decimals)
    "targetCurlThreshold": (0.5, 0.8, 2),
    "isolationTolerance": (0.2, 0.5, 2),
    "timingWindowMs": (200, 500, 0),
    "noteFallMs": (1100, 2600, 0),
    "sequenceLength": (8, 30, 0),
}
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
    """`accuracy_series` is oldest -> newest and ends with the round just played."""
    p = normalize_params(params)
    nxt = dict(p)
    total = stats.get("hits", 0) + stats.get("leaks", 0) + stats.get("misses", 0)
    if total == 0:
        return Adaptation("hold", nxt, rationale="No notes were judged, so the settings stay the same.", confidence=0.0)

    lv = judge(accuracy_series, trend, dev)
    verdict, step, last, level, q, n = lv.verdict, lv.step, lv.last, lv.smoothed, lv.q, lv.n
    confidence = lv.confidence

    mb = dev.metric_badness if dev else {}
    raw_pooled = {i.metric: i for i in (dev.pooled if dev else [])}
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

    if verdict == "harder":
        why = f"Accuracy {smoothed}" + (", improving" if trend.direction == "improving" else ", steady")
        move("noteFallMs", -150 * step, "harder", f"{why}: notes arrive faster")
        if mb.get("leak", 0) < 0.6:
            move("isolationTolerance", -0.03 * step, "harder", "Finger isolation matches the reference: less leakage allowed")
        if mb.get("latency_ms", 0) < 0.6:
            move("timingWindowMs", -25 * step, "harder", "Timing matches the reference: tighter window")
        pk = raw_pooled.get("peak_curl")
        if pk and mb.get("peak_curl", 0) < 0.5 and pk.value >= p["targetCurlThreshold"] + 0.12:
            move("targetCurlThreshold", 0.03 * step, "harder", f"Curl depth {pk.value:.2f} is well past the threshold: ask for more")
        if q >= 0.93:
            move("sequenceLength", 2, "harder", "Near-perfect rounds: longer round for endurance")
    elif verdict == "easier":
        why = f"Accuracy {smoothed}" + (", declining" if declining else "")
        dominant = max(
            (m for m in ("leak", "latency_ms", "peak_curl", "smoothness") if m in mb),
            key=lambda m: mb[m],
            default=None,
        )
        dom_txt = f" Biggest cost: {LABELS[dominant]}." if dominant and mb[dominant] >= 0.75 else ""
        miss_rate = stats.get("misses", 0) / total
        leak_rate = stats.get("leaks", 0) / total
        if dominant in (None, "leak", "smoothness", "latency_ms"):
            move("noteFallMs", 200 * step, "easier", f"{why}: more time per note.{dom_txt}")
        if leak_rate > 0.3 and mb.get("leak", 0) >= 0.75:
            move("isolationTolerance", 0.04 * step, "easier", "Fingers move together on many presses: a little more allowance")
        if (miss_rate >= 0.3 or dominant == "peak_curl") and mb.get("peak_curl", 0) >= 0.75:
            move("targetCurlThreshold", -0.03 * step, "easier", f"Presses fall short of the reference curl: a smaller curl counts.{dom_txt}")
        if (miss_rate >= 0.3 or dominant == "latency_ms") and mb.get("latency_ms", 0) >= 0.75:
            move("timingWindowMs", 40 * step, "easier", f"Presses land off the beat: wider timing window.{dom_txt}")
        if q < 0.4 and p["sequenceLength"] > 10:
            move("sequenceLength", -2, "easier", "Shorter round to stay fresh")
    else:
        worst = max(mb, key=lambda m: mb[m], default=None)
        if worst == "leak" and mb[worst] >= 1.5:
            move("noteFallMs", 100, "easier", "Fingers aren't isolating yet: a touch more time to separate them")

    focus_update(p["focusFinger"], p["focusBoost"], dev, verdict, total, nxt, changes)

    moved = [c for c in changes if c.key in BOUNDS]
    rationale = summarize(verdict, smoothed, len(moved), bool(changes), n)

    return Adaptation(
        verdict=verdict,
        next_params=nxt,
        changes=changes,
        rationale=rationale,
        confidence=confidence,
        quality=round(q, 3),
        focus_finger=nxt["focusFinger"],
    )
