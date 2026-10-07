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

from engine.api.assignments import router as assignments_router
from engine.api.attempts import router as attempts_router
from engine.api.auth import router as auth_router
from engine.api.exercises import router as exercises_router
from engine.api.prescriptions import router as prescriptions_router
from engine.storage import cache
from engine.storage.db import engine as db_engine, init_db

app = FastAPI(title="Rehab Engine", version="0.1.0")

# dev-only origins for the Next.js interface app; tighten to the real
# deployed frontend origin(s) before any non-local deployment
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
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

    try:
        cache.ping()
        checks["redis"] = "ok"
    except Exception as e:
        checks["redis"] = f"error: {e}"

    status = "ok" if all(v == "ok" for v in checks.values()) else "degraded"
    return {"status": status, "checks": checks}


app.include_router(auth_router)
app.include_router(assignments_router)
app.include_router(exercises_router)
app.include_router(prescriptions_router)
app.include_router(attempts_router)
