# Rehab Engine (backend)

A FastAPI service that stores rehab sessions ("attempts") and enforces who may
see them. It's designed as game-agnostic middleware: games tag attempts with an
`exercise_id`, and the engine never hardcodes exercise logic.

## Run

```bash
cd engine
python -m venv .venv && source .venv/bin/activate
pip install -e .
uvicorn engine.main:app --reload    # start from engine/ so .env is found
```

Open http://localhost:8000/docs for the Swagger UI. Use **Authorize** with a
a Supabase access token (sign in through the interface or the Supabase SDK).

### Seeding the first admin

There's no self-signup for any role -- admins invite admins/physiatrists,
physiatrists invite patients (`POST /auth/invite`). That chain needs one
admin to already exist, so the very first one is created directly:

Create it in the Supabase dashboard (Authentication > Users, with `user_metadata` `{"role": "admin"}`), sign in
once through the interface, and the profile is created by `POST /auth/complete-profile`.

## Configuration

`engine/config.py` uses pydantic-settings with prefix `ENGINE_`, read from
`.env`.

| Variable | Default | Purpose |
|---|---|---|
| `ENGINE_DATABASE_URL` | local `postgresql+psycopg://…/rehab_engine` | Postgres (normally the Supabase DB) |
| `ENGINE_CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | browser origins allowed to call the API |
| `ENGINE_TRIM_PATIENT_FRAMES` | `true` | store patient rounds slim (see docs/deploy.md) |
| `ENGINE_INVITE_REDIRECT_URL` | `http://localhost:3000/accept-invite` | where invite links land |
| `ENGINE_SUPABASE_URL` | — | JWKS endpoint, admin client |
| `ENGINE_SUPABASE_PUBLISHABLE_KEY` | — | `apikey` header for Supabase calls |
| `ENGINE_SUPABASE_SERVICE_ROLE_KEY` | — | Admin API (invites, deletes, bans). Use the **legacy service_role JWT**, because Supabase CLI v2.72.8 redacts `sb_secret_*` keys. |

## Code map

| Module | Contents |
|---|---|
| `main.py` | App, CORS, startup `init_db()`, `/health`, router registration |
| `api/auth.py` | `/auth/invite`, `/auth/complete-profile`, `/auth/me`, team and patient admin |
| `api/exercises.py` | Exercise catalog |
| `api/prescriptions.py` | Exercise → patient prescriptions |
| `api/attempts.py` | Batch ingest and reads |
| `auth/security.py` | ES256 JWT verification against Supabase JWKS |
| `auth/deps.py` | `get_current_user`, `require_role(...)` |
| `auth/supabase_admin.py` | Lazy service-role Supabase client |
| `storage/models.py` | `Profile`, `PhysiatristPatient`, `Exercise`, `PatientExercise`, `Attempt` |
| `storage/db.py` | SQLAlchemy engine, `get_session()` |

See [`../docs/api.md`](../docs/api.md), [`../docs/data-model.md`](../docs/data-model.md)
and [`../docs/architecture.md`](../docs/architecture.md).
