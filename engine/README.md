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
Supabase email and password, which goes through `/auth/login`.

Redis is expected locally: `docker run -d -p 6379:6379 redis:7`.

## Configuration

`engine/config.py` uses pydantic-settings with prefix `ENGINE_`, read from
`.env`.

| Variable | Default | Purpose |
|---|---|---|
| `ENGINE_DATABASE_URL` | local `postgresql+psycopg://…/rehab_engine` | Postgres (normally the Supabase DB) |
| `ENGINE_REDIS_URL` | `redis://localhost:6379/0` | live-attempt frame buffer |
| `ENGINE_SUPABASE_URL` | — | JWKS endpoint, login passthrough, admin client |
| `ENGINE_SUPABASE_PUBLISHABLE_KEY` | — | `apikey` header for `/auth/login` passthrough |
| `ENGINE_SUPABASE_SERVICE_ROLE_KEY` | — | Admin API for `/auth/register`. Use the **legacy service_role JWT**, because Supabase CLI v2.72.8 redacts `sb_secret_*` keys. |

## Code map

| Module | Contents |
|---|---|
| `main.py` | App, CORS, startup `init_db()`, `/health`, router registration |
| `api/auth.py` | `/auth/register`, `/auth/login`, `/auth/complete-profile`, `/auth/me` |
| `api/assignments.py` | Physiatrist ↔ patient links |
| `api/exercises.py` | Exercise catalog |
| `api/prescriptions.py` | Exercise → patient prescriptions |
| `api/attempts.py` | Batch and live (begin / WS stream / end) ingest, and reads |
| `auth/security.py` | ES256 JWT verification against Supabase JWKS |
| `auth/deps.py` | `get_current_user`, `require_role(...)` |
| `auth/supabase_admin.py` | Lazy service-role Supabase client |
| `storage/models.py` | `Profile`, `PhysiatristPatient`, `Exercise`, `PatientExercise`, `Attempt` |
| `storage/db.py` | SQLAlchemy engine, `get_session()` |
| `storage/cache.py` | Redis attempt buffer (30-min TTL) |

See [`../docs/api.md`](../docs/api.md), [`../docs/data-model.md`](../docs/data-model.md)
and [`../docs/architecture.md`](../docs/architecture.md).
