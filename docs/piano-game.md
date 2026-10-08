# Piano Press

Route: `/patient/piano` (`interface/src/app/patient/piano/page.tsx`).
Exercise id: `piano_isolated_press`.
Purpose: train **isolated finger flexion**, meaning the patient curls one
finger at a time while keeping the others still.

## How it plays

- There are five lanes, one per finger, each mapped to a note:
  thumb **C4**, index **D4**, middle **E4**, ring **G4**, pinky **A4**.
- Notes spawn in random lanes and fall toward the green target line.
- When a note reaches the line (± the timing window), the patient curls that
  finger past the threshold.
- Each lane shows a live curl bar. The **3D hand twin** highlights the finger
  for the next pending note in that note's lane color.

## Judging (`interface/src/lib/pianoGame.ts`, ported from `cv-poc/piano_game.py`)

For each unjudged note, on every frame:

| Condition | Result | Points | Sound |
|---|---|---|---|
| Within `±timingWindowMs` of hit time, target curl ≥ `targetCurlThreshold`, and no other finger above `isolationTolerance` | **hit** | +10 | clean sine tone for that finger's note |
| Same, but another finger is above `isolationTolerance` | **leak** | +2 | the same note, low-passed and quieter |
| Hit time + window passes without the target curl | **miss** | 0 | low square-wave thud |

**Ring and pinky are anatomically coupled**, so either one moving while the
other is the target doesn't count as a leak.

## Parameters (`DEFAULT_PARAMS`)

| Param | Default | Meaning |
|---|---|---|
| `targetCurlThreshold` | 0.65 | curl the target finger must reach |
| `isolationTolerance` | 0.35 | the maximum curl any other finger may have for a clean hit |
| `timingWindowMs` | 350 | ± window around the hit time |
| `noteFallMs` | 1800 | time from spawn to the target line |
| `sequenceLength` | 16 | notes per round |

Notes are spaced `noteFallMs / 1.6` (about 1125 ms) apart, and the first note
spawns 500 ms after start. These parameters are what the planned
**adaptation** stage of the engine would tune per patient.

## Session lifecycle

1. **Start session** unlocks Web Audio (it needs a user gesture), reads the
   Supabase session token, loads MediaPipe and starts the camera.
2. Each `requestAnimationFrame` tick runs detection, then curls, then a 3D
   twin update, then a frame record push, then a game update, then sounds,
   then a canvas draw.
3. **Stop** releases the camera and landmarker, then sends one
   `POST /attempts/batch` with every frame and
   `meta = {score, hits, leaks, misses}`.
4. The summary card shows score, hits, leaks, misses and notes completed.

The round doesn't stop automatically when all 16 notes are judged.
`game.finished` becomes true, but nothing is submitted until the patient
presses **Stop**.

## 3D hand twin (`interface/src/components/HandTwin3D.tsx`)

- Loads `public/simplehand.fbx`, which has 21 bones: a wrist plus five chains
  of four bones each, named `Bone`, `Bone001`…`Bone020`.
- Mapping from chain to finger:
  `Bone001-004` thumb, `005-008` index, `009-012` middle, `013-016` ring,
  `017-020` pinky. This was worked out from bind-pose positions.
- Only the curl value drives the hand. The pose stays fixed with the palm
  facing the camera. For each finger, bones 2–4 each rotate
  `curl × 260°/3` around a flexion axis that belongs to that bone, computed at
  load time as palm normal × that bone's direction toward its child.
- To highlight a finger, vertex colors are repainted using each vertex's
  dominant skin-weight bone.
- The parent page drives the twin through a ref handle with the method
  `update(curls, highlightFinger)`.

## Full-screen flow and adaptation

The game takes the whole screen: intro (previous attempts and the settings about
to be used) -> camera warm-up -> 3-2-1 -> play -> outro animation -> results
(this round, how it compares with the idealized reference and the previous round,
and the settings the next round will use) -> next attempt. The hand twin is a
draggable picture-in-picture panel. The settings come from the engine, see
[adaptation.md](adaptation.md). `GameParams` also carries `focusFinger` and
`focusBoost`: with that probability a note is the focus finger.
