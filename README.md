# Rehab Engine — TRSYP 3 Tech Challenge

A hand-rehabilitation platform. Patients play camera-driven finger exercises
in the browser. Every session is recorded as a stream of per-frame hand
features and stored, so it can later be scored against an "idealized"
reference performance and reviewed by the patient's physiatrist.

The repo has two parts:

| Directory | What it is | Stack |
|---|---|---|
| [`engine/`](engine/README.md) | Backend API ("rehab engine"): auth, care relationships, exercise catalog, prescriptions, attempt ingestion | Python 3.11+, FastAPI, SQLModel, Postgres (Supabase), Redis |
| [`interface/`](interface/README.md) | Web app for patients, physiatrists and admins. Includes the **Piano Press** game | Next.js 16, React 19, MediaPipe Hand Landmarker, Three.js, Supabase JS |

```
 Browser (interface/)                                  engine/
 ┌────────────────────────────────────┐            ┌──────────────────────┐
 │ webcam ─► MediaPipe (WASM, local)  │            │ FastAPI              │
 │            │ 21 landmarks/frame    │            │  /auth  /care │
 │            ▼                       │  Bearer    │  /exercises          │
 │   handFeatures.ts ─► FrameRecord[] ├──JWT──────►│  /prescriptions      │
 │            │ curls                 │  /attempts │  /attempts           │
 │            ▼                       │   /batch   └───┬──────────┬───────┘
 │   pianoGame.ts + HandTwin3D (3D)   │                │          │
 └──────────────┬─────────────────────┘          Postgres
                │ signUp / signIn               (Supabase)
                ▼
          Supabase Auth ──── JWKS (ES256) ────► engine verifies tokens
```

## Documentation

- [Architecture](docs/architecture.md): components, auth flow, the access-control model, and how an attempt moves through the system
- [Engine API reference](docs/api.md): every endpoint, the role it requires, and its errors
- [Deploying for free](docs/deploy.md): Vercel + Render + Supabase
- [Data model](docs/data-model.md): Postgres tables
- [Frame record schema](docs/frame-schema.md): the per-frame hand-feature JSON that games submit
- [Piano Press game](docs/piano-game.md): game rules, scoring, parameters, the 3D hand twin
- [Status & known issues](docs/status.md): what's built, what's planned, and gaps found while documenting

## Quick start

You need Python 3.11+, Node 20+, a Supabase project (or the local Supabase CLI
stack).

```bash
# 1. Engine
cd engine
python -m venv .venv && source .venv/bin/activate
pip install -e .
touch .env          # then fill in the variables below
uvicorn engine.main:app --reload          # http://localhost:8000, docs at /docs

# 2. Interface
cd ../interface
npm install
# create .env.local (see below)
npm run dev                               # http://localhost:3000
```

**`engine/.env`** (the engine reads it from the directory it's started in):

```dotenv
ENGINE_DATABASE_URL=postgresql+psycopg://USER:PASS@HOST:5432/postgres
ENGINE_SUPABASE_URL=https://<project-ref>.supabase.co
ENGINE_SUPABASE_PUBLISHABLE_KEY=<publishable/anon key>
ENGINE_SUPABASE_SERVICE_ROLE_KEY=<legacy service_role JWT>
```

**`interface/.env.local`**:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable/anon key>
NEXT_PUBLIC_ENGINE_URL=http://localhost:8000
```

Check the backend with `curl localhost:8000/health`. It reports Postgres
connectivity.

### Seeding enough data to play

A patient can only submit attempts for an exercise they've been prescribed.
Before Piano Press will save a session, do the following:

1. Register the exercise: `POST /exercises` with `{"exercise_id": "piano_isolated_press", "display_name": "Piano Press"}`.
2. Sign up a **physiatrist** and a **patient** through the interface.
3. As the physiatrist, invite the patient (Patients page), then prescribe: `POST /prescriptions {"patient_id": ..., "exercise_id": "piano_isolated_press"}`.

See [docs/api.md](docs/api.md#typical-setup-sequence) for the full curl sequence.

## Repository layout

```
engine/
  engine/
    main.py            FastAPI app, CORS, /health, router wiring
    config.py          Settings (ENGINE_* env vars)
    api/               Routers: auth, care, analytics, exercises, prescriptions, attempts
    auth/              Supabase JWT verification, role-gating deps, admin client
    storage/           SQLModel models, Postgres session
  supabase/config.toml Supabase CLI local-stack config
  pyproject.toml
interface/
  src/app/             Routes: /, /patient, /patient/piano, /physiatrist, /admin
  src/components/      AuthForm, HandTwin3D
  src/lib/             handFeatures (CV features), pianoGame, pianoSound, engine + supabase clients
  public/              hand_landmarker.task (MediaPipe model), simplehand.fbx (rigged hand)
docs/                  Project documentation
```

> `cv-poc/` (the original Python computer-vision proof of concept that
> `handFeatures.ts` and `pianoGame.ts` were ported from) is git-ignored and
> **not** in this repo.
