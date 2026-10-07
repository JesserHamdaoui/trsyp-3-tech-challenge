# Status & known issues

Snapshot as of commit `b3f740a` ("initiate the project").

## Built

- Supabase-backed auth with three roles, signup from the interface, and JWKS token verification
- Physiatrist ↔ patient assignment and exercise prescriptions
- Exercise catalog
- Attempt ingestion in two ways: a batch upload and a live begin/stream/end path backed by a Redis buffer
- Read access to attempts, scoped by role and assignment
- Interface: role landing pages, login/signup, and the Piano Press game with in-browser MediaPipe, a feature extractor at parity with `cv-poc` and a 3D hand twin

## Planned (from code comments)

1. Feature extraction on the server, to fill in `Attempt.features`
2. Reference models built from idealized attempts
3. Deviation scoring of patient attempts against the reference
4. Trend tracking across attempts
5. Aggregation
6. Adaptation, meaning per-patient difficulty tuning of game params
7. Live control-plane values streamed back to games (curl, grip strength, hand position)
8. Physiatrist and admin dashboards. Both pages are login-only today.

## Issues found while documenting

### Security

- **Anyone can pick their own role.** `/auth/complete-profile` takes `role`
  from `user_metadata`, and the client sets that freely in `signUp()`. So any
  visitor can sign up as `physiatrist` or `admin`.
- **`POST /auth/register` is unauthenticated.** It uses the service-role key
  to create confirmed users with any role.
- **`POST /exercises` is unauthenticated.** Anyone can add catalog entries.
- The WebSocket token travels in the query string, so it can end up in proxy
  and access logs.
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
