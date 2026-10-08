# Pinch Flight

Force-matching game for the sensor glove (FSR per fingertip + palm IMU). Exercise id `pinch_flight`.

## Play
A bird's height is the pinch force between the thumb and the **one finger the next gate asks for**, as a fraction
of the patient's own range. Each gate is a band of force; hold the bird inside it for the gate's whole length
(>= 75% of the time passes). Gates are `static`, `step` (changes level halfway) or `ramp`. Result per gate:
`hit`, `leak` (another finger carried more than `isolationTolerance`; ring/pinky coupling ignored) or `miss`.

Flow: intro -> camera warm-up -> calibration (once per page visit: open hand, then a firm pinch per finger) ->
countdown -> play -> outro -> results (this round / vs the ideal / next attempt).

## The glove abstraction (`interface/src/lib/glove.ts`)
Games only read `GlovePacket`s from a `GloveSource`:

```
{ t: ms (performance.now clock),
  fsr: {thumb,index,middle,ring,pinky: raw, higher = more force},
  imu: {ax,ay,az: g, gx,gy,gz: deg/s} }
```

`CameraGlove` simulates the glove from MediaPipe landmarks: FSR = closeness of the thumb tip to each fingertip,
IMU = second derivative / rotation rate of the palm. To use the real glove, write a `GloveSource` (Web Bluetooth /
Serial) that emits the same packets and swap it in where `new CameraGlove()` is created in `PinchGame.tsx`.
Calibration maps raw `fsr` to 0-1 per finger (`rest` .. `max`), so raw units don't matter.

## What is stored
Each frame record (docs/frame-schema.md) gets `glove: {t, fsr, force, imu}` (`force` = calibrated 0-1).
`meta`: `hits, leaks, misses, score, params, pipes[], calibration, glove.source`, where each pipe is
`{finger, start_ms, end_ms, kind, c0, c1, band, result, in_band}` on the frames' clock.

## Engine
- `engine/features/pinch.py`: per finger `force_error, overshoot, latency_ms, wobble, leak, clean_rate`
  (+ pooled `all.*`), hand-level `all.tremor` (4-12 Hz palm accel RMS, g) and `all.jerk`.
- `engine/games.py`: per-game spec (metrics + priors, extractor, adaptation). Scoring, history, trend and
  comparison are shared with Piano Press; `describe`/labels come from the spec.
- `engine/adapt/pinch.py`: stateless adaptation (shared verdict logic in `adapt/common.py`). Knobs:
  `forceLow, forceHigh, bandWidth, holdMs, restMs, scrollMs, dynamicMix, birdAssist, isolationTolerance,
  pipeCount, focusFinger/focusBoost`; at most 3 numeric changes per round.
- Tests: `python tests/test_pinch.py`.

Tremor/jerk from the camera are noisier than a real IMU; they are down-weighted (0.5 / 0.4) and judged against
references recorded with the same source. Re-record references when the real glove arrives.
