# Analysis and adaptation

How a finished round turns into "what happens next". Code lives in the engine,
the game only records and applies.

```
frames + meta.notes
   │  features/extract.py      per-note windows -> flat features
   ▼
Attempt.features
   │  scoring/reference.py     z-scores vs the idealized attempts (shrunk toward priors)
   ▼
deviation score + most-affecting features + weakest finger
   │  trend/trend.py           EWMA, slope with a significance test, volatility
   │  analysis.py              comparison with the previous attempt
   ▼
adapt/piano.py                 next game parameters, with reasons
```

Orchestrated by `engine/analysis.py`, exposed as `GET /attempts/{id}/analysis`,
`POST /attempts/analyze` (admin practice runs) and `GET /attempts/next-params`.
Features are stored on `Attempt.features` when a round is submitted, and
computed lazily for older attempts.

## What the game sends

`meta` of `POST /attempts/batch`: `hits`, `leaks`, `misses`, `score`,
`params` (the settings the round was played with) and `notes`: one
`{finger, hit_at_ms, judged_at_ms, result}` per judged note. `hit_at_ms` is on
the same clock as the frames' `timestamp_ms`, which is what lets the engine
cut a window of frames around every press. Attempts without `notes` (older or
seeded ones) fall back to `meta.target_finger` over the whole recording.

## Features (`Attempt.features`)

Per finger (`index.peak_curl`, ...) and pooled (`all.peak_curl`, ...):

| metric | meaning | better |
|---|---|---|
| `peak_curl` | peak curl of the pressed finger | higher |
| `leak` | peak curl of the other fingers while it was pressed (ring/pinky coupling ignored) | lower |
| `latency_ms` | absolute time between crossing the curl threshold and the note reaching the line | lower |
| `smoothness` | mean `movement_smoothness_score` | higher |
| `clean_rate` | share of that finger's notes judged a clean hit | higher |

Also `all.latency_bias_ms` (signed, negative = early) and `all.detection_rate`.

## Comparison with the idealized data

For each feature the reference is the mean and spread over the idealized
attempts, shrunk toward a prior with the weight of 2 attempts
(`SHRINK_K`): no recordings means the prior alone, many means the data
dominates. The spread never goes below half the prior's. A patient value is
judged one-sidedly: being better than the reference costs nothing, being
worse costs `badness = z` in the worse direction, times the metric's weight. Smoothness counts 0.3 because it is noisy and depends on how a clip was captured (the idealized clips are single presses, a patient's windows are continuous play). The other metrics count 1.

- **Deviation score** = `100 * exp(-rms(badness) / 3)` over the per-finger features. 100 is indistinguishable from the reference.
- **Drivers** (the most-affecting features) are ranked by their share of the total squared badness.
- **Finger badness** is the rms over one finger's features, and the worst finger becomes the focus finger.

## Comparison with previous attempts

`previous` holds accuracy, score and deviation-score deltas and the features
that moved by more than half a reference standard deviation, split into
improved and regressed. `trend` looks at the last 12 attempts: the smoothed
accuracy (EWMA, alpha 0.6), the slope over the last 6 with a t-statistic
(`improving`/`declining` need |t| >= 1 and a slope of at least 1 point per
attempt, otherwise `plateau`; fewer than 4 attempts is `building`) and the
volatility of the last 5.

## Adaptation (Piano Press)

Stateless: next settings = f(settings the round was played with, the analysis).

1. `q = 0.6 * smoothed accuracy + 0.4 * deviation score`. `q >= 0.82` with no decline and a last round >= 75% goes harder. `q < 0.5`, a last round under 40%, or a decline while `q < 0.65` goes easier. Otherwise it holds.
2. The step is halved with a single attempt or noisy results (volatility > 0.2) and x1.5 when `q >= 0.95` or `< 0.3`.
3. Going harder tightens what the patient already does well, checked per feature against the reference: speed first, then isolation, timing, curl depth, and round length at `q >= 0.93`.
4. Going easier eases what costs the most: more time per note, more isolation allowance when many presses leak, a smaller curl when presses fall short, a wider window when presses land off the beat.
5. Holding with one glaring weakness (isolation badness >= 1.5) gives a bit more time per note.
6. The focus finger is the finger that deviates most, once it stands out (badness >= 1 and 1.4x the median of the others). It then gets 15-40% of the notes until it is back in line.

At most three numeric settings change per round, each with a human-readable
reason. `adaptation.confidence` grows with the number of attempts and shrinks
with volatility. Settings are clamped (`BOUNDS` in `adapt/piano.py`).

Tests: `python engine/tests/test_analysis.py` (synthetic rounds through the whole pipeline on SQLite).
