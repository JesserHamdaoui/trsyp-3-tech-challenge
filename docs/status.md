# Status & known issues

Snapshot as of commit `b3f740a` ("initiate the project").

## Built

- Supabase-backed auth with three roles, signup from the interface, and JWKS token verification
- Physiatrist ↔ patient assignment and exercise prescriptions
- Exercise catalog
- Attempt ingestion by one batch upload per round
- Read access to attempts, scoped by role and assignment
- Patient progress page: streak, week strip, accuracy chart, finger strengths, badges, current game settings and recent rounds, built on `/attempts/history` and `/attempts/next-params`
- Physiatrist pages: overview with a triage list, patients, patient detail (progress, fingers, rounds, prescriptions) and a prescription matrix
- Server-side analysis pipeline for Piano Press: feature extraction, deviation scoring against the idealized reference, trend and adaptation ([adaptation.md](adaptation.md))
- Interface: role landing pages, login/signup, and the Piano Press game with in-browser MediaPipe, a feature extractor at parity with `cv-poc` and a 3D hand twin

## Planned (from code comments)

1. Aggregation across patients as a stored layer (the admin analytics endpoint computes it on the fly)
2. Adaptation for games other than Piano Press (the pipeline is in place, see [adaptation.md](adaptation.md))
3. Live control-plane values streamed back to games (curl, grip strength, hand position)
4. Physiatrist reports/export, clinical notes and a settings override

## Issues found while documenting

### Security

- **Anyone can pick their own role.** `/auth/complete-profile` takes `role`
  from `user_metadata`, and the client sets that freely in `signUp()`. So any
  visitor can sign up as `physiatrist` or `admin`.
- The role landing pages don't check that the logged-in user's role matches
  the page. A patient can "log in" on `/admin`. The backend still enforces
  roles.

### Functional gaps

- `/patient` lists **hardcoded** games and doesn't call
  `GET /prescriptions/my-exercises`.
- If the batch upload fails when a Piano session stops, the error only goes
  to `console.error`. The patient sees nothing and the frames are lost.
- The piano page hardcodes `handedness: "Unknown"` and confidence `0.9`.
  MediaPipe's real handedness output is ignored.
- Exercise id: the piano page submits under `piano_isolated_press`, but a
  comment in `handFeatures.ts` says the seeded reference attempts are
  `piano_game`. Confirm which id the 97 reference attempts were stored under,
  because scoring will need both sets under the same exercise.
- Admins can't list or read idealized attempts back. `GET /attempts`
  requires an assignment, and idealized attempts have no `patient_id`.
- The round doesn't end on its own after the last note. The patient has to
  press Stop.
- The MediaPipe WASM is loaded from the CDN at a pinned `0.10.14`, while
  `package.json` depends on `@mediapipe/tasks-vision ^1.1.0`. A version
  mismatch can break the loader.

### Ops / dev experience

- There are no migrations (`create_all` only) and no seed script.
- There are no tests, and there's no lint script in either package.
- `engine/supabase/` has a CLI config but no migrations or seeds directory.
- `engine/.env` is resolved relative to the working directory, so `uvicorn`
  has to be started from `engine/`.
- `@app.on_event("startup")` is deprecated in recent FastAPI versions in
  favor of lifespan handlers.
- CORS origins are hardcoded to localhost.


## Pinch Flight
Built: glove abstraction + camera simulator, game (`/patient/pinch`, `/admin/exercises/pinch`, `/admin/reference/pinch`), engine features/adaptation (docs/pinch-game.md). Exercise `pinch_flight` must exist in the catalog (registered locally). Not yet verified end-to-end in a browser with a camera.
