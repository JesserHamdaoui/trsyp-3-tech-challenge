"""
Keeps the database small on a free Postgres tier.

A round's frames are the heavy part of an attempt (about 3 MB of JSON), and once the features are computed
the engine only reads a few fields of them. `slim_frames` keeps exactly those; reference (idealized)
recordings are never slimmed. `purge` empties the frames of old patient rounds that already have features.

    python -m engine.retention --days 30          # dry run
    python -m engine.retention --days 30 --apply
"""

import argparse
from typing import Any

from sqlalchemy import func, text
from sqlmodel import Session, select

from engine.storage.db import engine
from engine.storage.models import Attempt

FINGERS = ("thumb", "index", "middle", "ring", "pinky")


def slim_frames(frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The fields the feature extractors and quality checks read; everything else is dropped."""
    out = []
    for f in frames:
        slim: dict[str, Any] = {k: f[k] for k in ("timestamp_ms", "frame_index", "hand_detected") if k in f}
        fingers = f.get("fingers")
        if isinstance(fingers, dict):
            slim["fingers"] = {
                n: {k: v[k] for k in ("curl_normalized", "movement_smoothness_score") if k in v}
                for n, v in fingers.items()
                if isinstance(v, dict)
            }
        if isinstance(f.get("glove"), dict):
            slim["glove"] = f["glove"]
        out.append(slim)
    return out


def purge(days: int, apply: bool) -> tuple[int, int]:
    """(attempts affected, megabytes freed) for patient rounds older than `days` that still carry frames."""
    with Session(engine) as s:
        rows = s.exec(
            select(Attempt.id, func.pg_column_size(Attempt.frames)).where(
                Attempt.is_idealized == False,  # noqa: E712
                Attempt.features.is_not(None),  # type: ignore[union-attr]
                Attempt.created_at < func.now() - text(f"interval '{int(days)} days'"),
                func.jsonb_array_length(Attempt.frames) > 0,
            )
        ).all()
        if apply and rows:
            ids = [r[0] for r in rows]
            s.exec(text("UPDATE attempt SET frames = '[]'::jsonb WHERE id = ANY(:ids)").bindparams(ids=ids))  # type: ignore[call-overload]
            s.commit()
        return len(rows), round(sum(r[1] or 0 for r in rows) / 1e6, 1)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=30, help="empty the frames of patient rounds older than this")
    ap.add_argument("--apply", action="store_true", help="actually do it (default is a dry run)")
    a = ap.parse_args()
    n, mb = purge(a.days, a.apply)
    print(f"{'emptied' if a.apply else 'would empty'} frames of {n} rounds ({mb} MB)")
