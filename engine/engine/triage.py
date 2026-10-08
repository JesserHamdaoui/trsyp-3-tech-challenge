"""
Who needs a physiatrist's attention, from a patient's recent rounds. Pure
function over (accuracy series, timestamps, prescriptions) so the rules are
testable and live in one place; thresholds are constants below.
"""

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal, Optional

from engine.trend.trend import analyze_trend

INACTIVE_DAYS = 7
NOT_STARTED_DAYS = 3
LOW_ACCURACY = 0.5
PLATEAU_MIN_ATTEMPTS = 6
PLATEAU_BELOW = 0.8

Status = Literal["needs_attention", "on_track", "new"]
Severity = Literal["high", "medium", "low"]


@dataclass
class Reason:
    code: str
    text: str
    severity: Severity


@dataclass
class Triage:
    status: Status
    reasons: list[Reason]
    trend: str
    recent_accuracy: Optional[float]


_ORDER = {"high": 0, "medium": 1, "low": 2}


def triage(
    *,
    accuracy_series: list[float],
    last_round_at: Optional[datetime],
    rounds: int,
    prescriptions: int,
    assigned_at: Optional[datetime],
    now: Optional[datetime] = None,
) -> Triage:
    """`accuracy_series` is oldest -> newest over all of the patient's scored rounds."""
    now = now or datetime.now(timezone.utc)
    reasons: list[Reason] = []
    trend = analyze_trend(accuracy_series)
    recent = sum(accuracy_series[-3:]) / len(accuracy_series[-3:]) if accuracy_series else None

    def days_since(t: datetime) -> int:
        t = t if t.tzinfo else t.replace(tzinfo=timezone.utc)
        return max(0, (now - t).days)

    if prescriptions == 0:
        reasons.append(Reason("no_prescription", "No exercise prescribed yet", "medium"))
    elif rounds == 0:
        waited = days_since(assigned_at) if assigned_at else 0
        if waited >= NOT_STARTED_DAYS:
            reasons.append(Reason("not_started", f"Hasn't played yet ({waited} days since assigned)", "medium"))
    if rounds and last_round_at is not None:
        gap = days_since(last_round_at)
        if gap >= INACTIVE_DAYS:
            reasons.append(Reason("inactive", f"No rounds in {gap} days", "high" if gap >= 14 else "medium"))
    if recent is not None and len(accuracy_series) >= 2 and recent < LOW_ACCURACY:
        reasons.append(Reason("low_accuracy", f"Low accuracy lately ({recent:.0%})", "high"))
    if trend.direction == "declining":
        reasons.append(Reason("declining", "Accuracy is declining", "high" if (recent or 0) < 0.7 else "medium"))
    if (
        trend.direction == "plateau"
        and len(accuracy_series) >= PLATEAU_MIN_ATTEMPTS
        and trend.level is not None
        and trend.level < PLATEAU_BELOW
    ):
        reasons.append(Reason("plateau", f"Progress has plateaued at {trend.level:.0%}", "low"))

    reasons.sort(key=lambda r: _ORDER[r.severity])
    if reasons:
        status: Status = "needs_attention"
    elif rounds == 0:
        status = "new"
    else:
        status = "on_track"
    return Triage(status, reasons, trend.direction, None if recent is None else round(recent, 3))
