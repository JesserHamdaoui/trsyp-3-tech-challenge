"""Trend over a patient's attempts: smoothed level, slope with a significance check, volatility."""

from dataclasses import dataclass
from math import sqrt
from statistics import fmean, pstdev
from typing import Literal, Optional

Direction = Literal["improving", "declining", "plateau", "building"]  # "building" = too few attempts to tell

SLOPE_WINDOW = 6
MIN_FOR_TREND = 4
MIN_MEANINGFUL_SLOPE = 0.01  # per attempt, on a 0-1 scale


def ewma(values: list[float], alpha: float = 0.6) -> Optional[float]:
    """Exponentially weighted mean, newest value last."""
    if not values:
        return None
    level = values[0]
    for v in values[1:]:
        level = alpha * v + (1 - alpha) * level
    return level


@dataclass
class Trend:
    n: int
    level: Optional[float]  # EWMA
    last: Optional[float]
    best: Optional[float]
    slope: Optional[float]  # per attempt over the last SLOPE_WINDOW
    t_stat: Optional[float]  # slope / standard error
    volatility: float  # std of the last 5
    direction: Direction


def analyze_trend(values: list[float]) -> Trend:
    """`values` oldest -> newest, 0-1 scale."""
    n = len(values)
    if n == 0:
        return Trend(0, None, None, None, None, None, 0.0, "building")
    recent = values[-SLOPE_WINDOW:]
    vol = pstdev(values[-5:]) if n >= 2 else 0.0
    slope = t = None
    direction: Direction = "building"
    if len(recent) >= MIN_FOR_TREND:
        k = len(recent)
        xs = list(range(k))
        xm, ym = fmean(xs), fmean(recent)
        sxx = sum((x - xm) ** 2 for x in xs)
        slope = sum((x - xm) * (y - ym) for x, y in zip(xs, recent)) / sxx
        resid = [y - (ym + slope * (x - xm)) for x, y in zip(xs, recent)]
        s = sqrt(sum(r * r for r in resid) / (k - 2))
        se = s / sqrt(sxx)
        t = slope / se if se > 1e-9 else (float("inf") if slope else 0.0)
        if abs(slope) < MIN_MEANINGFUL_SLOPE or abs(t) < 1.0:
            direction = "plateau"
        else:
            direction = "improving" if slope > 0 else "declining"
    return Trend(
        n=n,
        level=ewma(values),
        last=values[-1],
        best=max(values),
        slope=slope,
        t_stat=None if t is None or t in (float("inf"), float("-inf")) else t,
        volatility=vol,
        direction=direction,
    )
