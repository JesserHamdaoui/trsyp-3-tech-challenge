# Architecture

## Design intent

The engine describes itself as *game-agnostic sensor/CV middleware*
(`engine/pyproject.toml`). The planned pipeline is:

> ingest → feature extraction → reference models → deviation scoring → trend tracking → aggregation → adaptation

Only **ingest** exists today. Games never put exercise logic into the engine.
They tag each attempt with an `exercise_id` and send raw per-frame records,
and the engine stores them without interpreting them. Feature extraction
currently runs **in the browser** (`interface/src/lib/handFeatures.ts`), and
its output matches the schema of the idealized reference attempts already
seeded from `cv-poc`. That way a patient's attempts can be compared directly
with the reference, with no server-side reprocessing.

## Components

| Component | Responsibility |
|---|---|
| **Supabase Auth** | Owns identities and passwords and issues ES256-signed access tokens. |
| **Engine (FastAPI)** | Verifies tokens, holds app data (profiles with roles, assignments, catalog, prescriptions, attempts) and enforces who can see what. |
| **Postgres** (Supabase-hosted) | Durable storage. Tables are created at startup with `SQLModel.metadata.create_all`. There are no migrations. |
| **Interface (Next.js)** | Role landing pages, sign-up/login and the Piano Press game. All CV runs client-side. |

## Roles

`UserRole` in `engine/engine/storage/models.py`:

- **patient**: plays prescribed exercises and can only see their own attempts.
- **physiatrist**: assigns patients to themselves, prescribes exercises, and reads attempts of *assigned* patients only.
- **admin** ("demonstrator"): submits `is_idealized=true` reference attempts that seed or retrain an exercise's reference model. Their attempts have `patient_id = NULL`.

## Authentication

There are two ways to create an account.

**Primary: client-side signup** (`interface/src/components/AuthForm.tsx`)

```
browser ── supabase.auth.signUp({email, password, options.data: {role, full_name}}) ──► Supabase
browser ◄── session.access_token ─────────────────────────────────────────────────────── Supabase
browser ── POST /auth/complete-profile  (Bearer token) ──► engine
            engine reads role/full_name from the token's user_metadata, creates Profile row
```

This needs email confirmation **off** (`enable_confirmations = false` in
`supabase/config.toml`). Otherwise `signUp` returns no session and the form
shows an error.

**Login**: the interface calls `supabase.auth.signInWithPassword` directly; the engine only verifies the resulting token.

**Token verification** (`engine/engine/auth/security.py`): `PyJWKClient`
fetches Supabase's JWKS from `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
then checks the ES256 signature and `aud = "authenticated"`. No shared secret
is needed, and key rotation is handled automatically.

**Dependencies** (`engine/engine/auth/deps.py`):

- `get_verified_token_payload` verifies the token only. Only `/auth/complete-profile` uses it.
- `get_current_user` verifies the token **and** loads the `Profile`. It returns 401 if the profile is missing.
- `require_role(*roles)` builds on `get_current_user` and returns 403 if the role isn't allowed.

## Access-control model

Access is granted by two independent gates, each a join table:

```
            PhysiatristPatient                     PatientExercise
 physiatrist ───────────────► patient ◄──────────────────────── exercise
   "may see this patient's data"         "may submit attempts for this exercise"
```

- Being assigned to a patient **does not** prescribe anything.
- Prescribing **requires** an assignment to exist first.
- A patient's identity always comes from the token. `patient_id` from the
  client is never trusted on writes.
- Assignment checks live in each router rather than in a shared dependency,
  because what "access" means differs by resource.

## Attempt lifecycle

### Batch path (used by the interface today)

```
Piano page: every rAF tick ─► detectForVideo ─► buildFrameRecord ─► framesRef.push
Stop button ─► POST /attempts/batch {exercise_id, frames[], meta:{score,hits,leaks,misses}}
engine: check prescription (patients) or exercise exists (admins) ─► INSERT attempt
```

## Client-side CV pipeline (interface)

1. `getUserMedia` feeds a hidden `<video>`.
2. MediaPipe `HandLandmarker` runs in `VIDEO` mode on the GPU delegate, with
   one hand and 0.6 confidence thresholds. It loads its model from
   `public/hand_landmarker.task` and its WASM from jsDelivr.
3. On each animation frame, the 21 landmarks go through two steps.
   `allCurls` produces per-finger curl values from 0 to 1, which drive the
   game and the 3D twin. `buildFrameRecord` produces the full feature record
   that gets stored.
4. Frames with no hand detected are still recorded as `{hand_detected: false}`.

An earlier WebRTC design sent frames from the browser to a Python
`cv_server` and back. It was dropped because of latency.
