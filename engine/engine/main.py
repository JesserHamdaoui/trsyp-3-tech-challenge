"""
Engine entrypoint. Step 1: skeleton + exercise registry + attempt ingest,
no scoring/trend/aggregate/adapt yet (those are separate, already-validated
pipeline stages ported in from cv-poc over the next steps).

Run:
    uvicorn engine.main:app --reload
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from engine.api.analytics import router as analytics_router
from engine.api.attempts import router as attempts_router
from engine.api.auth import router as auth_router
from engine.api.care import router as care_router
from engine.api.exercises import router as exercises_router
from engine.api.prescriptions import router as prescriptions_router
from engine.config import settings
from engine.storage.db import engine as db_engine, init_db

app = FastAPI(title="Rehab Engine", version="0.1.0")

# the interface's origin(s): ENGINE_CORS_ORIGINS, comma-separated
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip().rstrip("/") for o in settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    init_db()


@app.get("/health")
def health():
    checks = {}

    try:
        with db_engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        checks["postgres"] = "ok"
    except Exception as e:
        checks["postgres"] = f"error: {e}"

    status = "ok" if all(v == "ok" for v in checks.values()) else "degraded"
    return {"status": status, "checks": checks}


app.include_router(auth_router)
app.include_router(exercises_router)
app.include_router(prescriptions_router)
app.include_router(attempts_router)
app.include_router(analytics_router)
app.include_router(care_router)
