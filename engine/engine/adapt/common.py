"""Pieces of difficulty adaptation shared by every game (see adapt/piano.py for the full rationale)."""

from dataclasses import dataclass, field
from statistics import median
from typing import Any, Literal, Optional

from engine.scoring.reference import Deviation
from engine.trend.trend import Trend, ewma

Verdict = Literal["harder", "easier", "hold"]


@dataclass
class Change:
    key: str
    from_: Any
    to: Any
    direction: Literal["harder", "easier"]
    reason: str


@dataclass
class Adaptation:
    verdict: Verdict
    next_params: dict[str, Any]
    changes: list[Change] = field(default_factory=list)
    rationale: str = ""
    confidence: float = 0.0
    quality: Optional[float] = None  # q, 0-1
    focus_finger: Optional[str] = None


@dataclass
class Level:
    verdict: Verdict
    q: float  # blended quality, 0-1
    last: float
    smoothed: float
    step: float  # multiplier for how far to move a setting
    confidence: float
    n: int


def judge(accuracy_series: list[float], trend: Trend, dev: Optional[Deviation]) -> Level:
    """Where the patient is: q blends smoothed accuracy (EWMA, so one fluke round doesn't swing things)
    with the deviation score against the idealized reference."""
    last = accuracy_series[-1]
    level = ewma(accuracy_series) or last
    dev_score = (dev.score / 100.0) if dev and dev.items else None
    q = 0.6 * level + 0.4 * dev_score if dev_score is not None else level
    n = len(accuracy_series)

    declining = trend.direction == "declining"
    if q >= 0.82 and not declining and last >= 0.75:
        verdict: Verdict = "harder"
    elif q < 0.5 or last < 0.4 or (declining and q < 0.65):
        verdict = "easier"
    else:
        verdict = "hold"

    step = 1.0
    if n < 2:
        step *= 0.5
    if trend.volatility > 0.2:
        step *= 0.5
    if q >= 0.95 or q < 0.3:
        step *= 1.5
    confidence = round(min(1.0, n / 4) * (1 - min(0.5, trend.volatility * 1.5)), 2)
    return Level(verdict, q, last, level, step, confidence, n)


def focus_update(
    focus: Optional[str], boost: float, dev: Optional[Deviation], verdict: Verdict, total: int, nxt: dict[str, Any],
    changes: list[Change], *, fingers_ok: Optional[set[str]] = None,
) -> None:
    """Spend more pipes/notes on the finger that deviates most, until it no longer stands out."""
    fb = dict(dev.finger_badness) if dev else {}
    if fingers_ok is not None:
        fb = {f: v for f, v in fb.items() if f in fingers_ok}
    if fb and total >= 5:
        worst_f = max(fb, key=lambda f: fb[f])
        others = [v for f, v in fb.items() if f != worst_f]
        stands_out = fb[worst_f] >= 1.0 and (not others or fb[worst_f] >= 1.4 * median(others))
        if stands_out:
            new_boost = round(min(0.4, max(0.15, 0.15 + 0.12 * fb[worst_f])), 2)
            if focus != worst_f or abs(boost - new_boost) > 0.04:
                changes.append(
                    Change(
                        "focusFinger", focus, worst_f, "easier" if verdict != "harder" else "harder",
                        f"{worst_f.capitalize()} deviates most from the reference: it appears more often",
                    )
                )
            nxt["focusFinger"], nxt["focusBoost"] = worst_f, new_boost
        elif focus and fb.get(focus, 0.0) < 0.6:
            nxt["focusFinger"], nxt["focusBoost"] = None, 0.0
            changes.append(Change("focusFinger", focus, None, "harder", f"{focus.capitalize()} is back in line with the reference"))


def summarize(verdict: Verdict, smoothed: str, moved: int, has_changes: bool, n: int) -> str:
    if verdict == "hold" and not has_changes:
        out = f"Balanced round ({smoothed}). Keeping the settings steady."
    elif verdict == "hold":
        out = f"Accuracy is balanced ({smoothed}); only small targeted tweaks."
    else:
        word = "harder" if verdict == "harder" else "easier"
        out = f"{'Strong' if verdict == 'harder' else 'Tough'} recent results ({smoothed}); making the game {word} on {moved} setting{'s' if moved != 1 else ''}."
    if n < 2:
        out += " Only one attempt so far, so changes are small."
    return out
