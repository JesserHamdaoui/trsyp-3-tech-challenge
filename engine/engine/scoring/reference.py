"""
Deviation scoring against the idealized (admin-recorded) attempts.

For each feature the reference is a mean and a spread taken from the idealized
attempts' features. Few demonstrations make a poor estimate of spread, so both
are shrunk toward a sensible prior with weight `SHRINK_K` pseudo-observations
(n idealized attempts count as n): with no references the prior alone is used,
with many the data dominates. The std never drops below half the prior's, so a
single tight demonstration can't make every patient look terrible.

A patient value is judged one-sidedly: being *better* than the reference is not
a deviation. `badness` is the z-score in the "worse" direction, floored at 0.
The attempt's deviation score is 100 * exp(-rms(badness) / 3), and each
feature's share of the squared badness says how much it cost.
"""

from dataclasses import dataclass, field
from math import exp, sqrt
from statistics import fmean, pvariance
from typing import Optional

FINGERS = ("thumb", "index", "middle", "ring", "pinky")


@dataclass(frozen=True)
class Metric:
    """One feature family. `per_finger` metrics exist as `<finger>.<name>` and pooled as `all.<name>`;
    the rest (hand-level, like tremor) exist only as `all.<name>`."""

    mean: float  # prior mean
    std: float  # prior std
    polarity: int  # +1 higher is better, -1 lower is better
    label: str
    weight: float = 1.0  # how much it counts toward badness
    per_finger: bool = True
    unit: str = "num"  # num | ms | ms_beat | pct | mg


# Piano Press. Smoothness (the 1/(1+CV) of tip velocity over 5 frames) is noisy and depends on how a
# recording was captured: the idealized clips are short single presses, a patient's windows are
# continuous play, so a flawless round can still read as "not smooth". It is kept as a hint, not a verdict.
PIANO_METRICS: dict[str, Metric] = {
    "peak_curl": Metric(0.85, 0.08, +1, "curl depth"),
    "leak": Metric(0.12, 0.08, -1, "finger isolation"),
    "latency_ms": Metric(120.0, 80.0, -1, "timing", unit="ms_beat"),
    "smoothness": Metric(0.75, 0.2, +1, "movement smoothness", weight=0.3),
    "clean_rate": Metric(0.95, 0.08, +1, "clean presses", unit="pct"),
}
SHRINK_K = 2.0
MIN_STD_FRACTION = 0.5

LABELS = {k: m.label for k, m in PIANO_METRICS.items()}


@dataclass
class FeatureStat:
    mean: float
    std: float
    n: int  # idealized attempts that contributed
    polarity: int


@dataclass
class ReferenceProfile:
    stats: dict[str, FeatureStat] = field(default_factory=dict)
    n_attempts: int = 0
    metrics: dict[str, Metric] = field(default_factory=lambda: PIANO_METRICS)

    @property
    def source(self) -> str:
        return "idealized" if self.n_attempts else "prior"


def feature_keys(metrics: dict[str, Metric]) -> list[str]:
    keys = []
    for name, m in metrics.items():
        if m.per_finger:
            keys += [f"{f}.{name}" for f in FINGERS]
        keys.append(f"all.{name}")
    return keys


def build_profile(feature_sets: list[dict[str, float]], metrics: dict[str, Metric] = PIANO_METRICS) -> ReferenceProfile:
    profile = ReferenceProfile(n_attempts=len(feature_sets), metrics=metrics)
    for key in feature_keys(metrics):
        m = metrics[key.split(".", 1)[1]]
        vals = [fs[key] for fs in feature_sets if key in fs]
        n = len(vals)
        if n:
            mu = fmean(vals)
            var = pvariance(vals) if n > 1 else 0.0
        else:
            mu, var = m.mean, m.std * m.std
        mean = (n * mu + SHRINK_K * m.mean) / (n + SHRINK_K)
        std = max(sqrt((n * var + SHRINK_K * m.std * m.std) / (n + SHRINK_K)), m.std * MIN_STD_FRACTION)
        profile.stats[key] = FeatureStat(mean=mean, std=std, n=n, polarity=m.polarity)
    return profile


@dataclass
class DeviationItem:
    key: str
    finger: str
    metric: str
    value: float
    ref_mean: float
    ref_std: float
    z: float  # signed: positive = worse than reference
    badness: float  # max(0, z)
    share: float = 0.0  # share of the attempt's squared badness


@dataclass
class Deviation:
    score: float  # 0-100, 100 = indistinguishable from the reference
    rms: float
    items: list[DeviationItem]  # per-finger features (+ hand-level ones), worst first
    finger_badness: dict[str, float]
    metric_badness: dict[str, float]
    pooled: list[DeviationItem]  # all.* headline features


def _item(key: str, value: float, st: FeatureStat, metrics: dict[str, Metric]) -> DeviationItem:
    z = st.polarity * (st.mean - value) / st.std
    scope, name = key.split(".", 1)
    return DeviationItem(key, scope, name, value, st.mean, st.std, z, max(0.0, z) * metrics[name].weight)


def deviation(features: dict[str, float], profile: ReferenceProfile) -> Deviation:
    metrics = profile.metrics
    items = [
        _item(f"{f}.{name}", features[f"{f}.{name}"], profile.stats[f"{f}.{name}"], metrics)
        for name, m in metrics.items()
        if m.per_finger
        for f in FINGERS
        if f"{f}.{name}" in features
    ]
    pooled = [
        _item(f"all.{name}", features[f"all.{name}"], profile.stats[f"all.{name}"], metrics)
        for name in metrics
        if f"all.{name}" in features
    ]
    # hand-level metrics (tremor, jerk) have no per-finger form: they count as items of scope "all"
    items += [i for i in pooled if not metrics[i.metric].per_finger]

    sq = sum(i.badness**2 for i in items)
    for i in items:
        i.share = (i.badness**2 / sq) if sq else 0.0
    items.sort(key=lambda i: i.badness, reverse=True)

    rms = sqrt(sq / len(items)) if items else 0.0
    score = 100.0 * exp(-rms / 3.0) if items else 0.0

    finger_badness: dict[str, float] = {}
    for f in FINGERS:
        b = [i.badness**2 for i in items if i.finger == f]
        if b:
            finger_badness[f] = sqrt(fmean(b))
    metric_badness: dict[str, float] = {}
    for name in metrics:
        b = [i.badness**2 for i in items if i.metric == name]
        if b:
            metric_badness[name] = sqrt(fmean(b))
    return Deviation(round(score, 1), rms, items, finger_badness, metric_badness, pooled)


def _fmt(unit: str, v: float) -> str:
    if unit == "ms_beat":
        return f"{v:.0f} ms off the beat"
    if unit == "ms":
        return f"{v:.0f} ms"
    if unit == "mg":
        return f"{v * 1000:.0f} mg"
    if unit == "pct":
        return f"{v:.0%}"
    return f"{v:.2f}"


def describe(item: DeviationItem, metrics: dict[str, Metric] = PIANO_METRICS) -> str:
    """Human sentence for one deviation, e.g. 'Ring finger isolation: 0.52 (reference 0.14)'."""
    m = metrics[item.metric]
    who = "Hand" if not m.per_finger else "All fingers" if item.finger == "all" else item.finger.capitalize()
    return f"{who} {m.label}: {_fmt(m.unit, item.value)} (reference {_fmt(m.unit, item.ref_mean)})"
