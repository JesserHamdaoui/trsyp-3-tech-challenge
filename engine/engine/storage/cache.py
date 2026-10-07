"""
Redis client, shared across the process. Buffers an in-progress attempt's
incoming frames between begin/end signals (via a Redis list, one push per
frame at full sensor/CV rate) so Postgres only takes one write per completed
attempt, not one per frame. Also holds a short marker recording which
patient/exercise owns an in-progress attempt_id, so /end and the WebSocket
handler can validate ownership without a DB round-trip on every frame.

Live control-plane primitives (curl, grip_strength, hand_position) are a
separate future concern (a game's WS connection reading the latest value at
frame rate) and don't belong in this per-attempt frame buffer.
"""

import json

import redis

from engine.config import settings

redis_client = redis.Redis.from_url(settings.redis_url, decode_responses=True)

ATTEMPT_TTL_SECONDS = 60 * 30  # in-progress attempts abandoned (client crash, no /end call) expire after 30 min


def ping() -> bool:
    return redis_client.ping()


def _frames_key(attempt_id: str) -> str:
    return f"attempt:{attempt_id}:frames"


def _meta_key(attempt_id: str) -> str:
    return f"attempt:{attempt_id}:meta"


def start_attempt_buffer(attempt_id: str, patient_id: str, exercise_id: str, is_idealized: bool) -> None:
    """patient_id is the string form of the owning Profile's UUID -- kept as
    a plain string here since this module only ever compares it for
    equality, never needs UUID semantics."""
    meta = {"patient_id": patient_id, "exercise_id": exercise_id, "is_idealized": is_idealized}
    redis_client.set(_meta_key(attempt_id), json.dumps(meta), ex=ATTEMPT_TTL_SECONDS)
    redis_client.expire(_frames_key(attempt_id), ATTEMPT_TTL_SECONDS)


def get_attempt_meta(attempt_id: str) -> dict | None:
    raw = redis_client.get(_meta_key(attempt_id))
    return json.loads(raw) if raw else None


def push_frame(attempt_id: str, frame: dict) -> int:
    """Appends one frame, refreshes TTL (a live stream shouldn't expire
    mid-attempt), returns the new frame count."""
    key = _frames_key(attempt_id)
    count = redis_client.rpush(key, json.dumps(frame))
    redis_client.expire(key, ATTEMPT_TTL_SECONDS)
    redis_client.expire(_meta_key(attempt_id), ATTEMPT_TTL_SECONDS)
    return count


def get_all_frames(attempt_id: str) -> list[dict]:
    raw_frames = redis_client.lrange(_frames_key(attempt_id), 0, -1)
    return [json.loads(f) for f in raw_frames]


def frame_count(attempt_id: str) -> int:
    return redis_client.llen(_frames_key(attempt_id))


def clear_attempt_buffer(attempt_id: str) -> None:
    redis_client.delete(_frames_key(attempt_id), _meta_key(attempt_id))
