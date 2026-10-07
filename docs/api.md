# Engine API reference

Base URL in development is `http://localhost:8000`. FastAPI serves
interactive docs at `/docs` and the OpenAPI spec at `/openapi.json`.

Authenticated endpoints expect `Authorization: Bearer <supabase access token>`.
CORS allows `http://localhost:3000` and `http://127.0.0.1:3000` only.

Auth column legend: **—** none, **token** valid JWT (no profile needed),
**any** logged-in user with a profile, or a specific role name.

## Health

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | — | `{"status": "ok"\|"degraded", "checks": {"postgres": ..., "redis": ...}}` |

## Auth: `/auth`

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/auth/register` | — | `{email, password, role, full_name?}` | `UserOut`. Creates a Supabase user with the service-role key, plus a Profile. `409` if the email already exists. |
| POST | `/auth/login` | — | form: `username`, `password` | `{access_token, token_type, role, user_id}`. `401` on bad credentials, `500` if the Supabase user has no Profile. |
| POST | `/auth/complete-profile` | token | — | `UserOut`. Creates the Profile from the token's `user_metadata.role`/`full_name`. `400` if the role is missing or invalid, `409` if the profile already exists. |
| GET | `/auth/me` | any | — | `UserOut` `{id, email, role, full_name}` |

## Assignments: `/assignments`

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/assignments` | physiatrist | `{patient_id}` | `{id, physiatrist_id, patient_id}`. `404` if the target isn't a patient, `409` if already assigned. |
| GET | `/assignments/my-patients` | physiatrist | — | list of assignments |
| GET | `/assignments/my-physiatrists` | patient | — | list of assignments |

## Exercises: `/exercises`

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/exercises` | — ⚠️ | `{exercise_id, display_name, description?}` | `Exercise`. `409` if the id already exists. |
| GET | `/exercises` | — | — | all exercises |
| GET | `/exercises/{exercise_id}` | — | — | one exercise, or `404` |

⚠️ This endpoint is currently unauthenticated. See [status.md](status.md).

## Prescriptions: `/prescriptions`

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/prescriptions` | physiatrist | `{patient_id, exercise_id}` | `{id, patient_id, exercise_id, prescribed_by_id}`. `403` if the patient isn't assigned to the caller, `404` for an unknown exercise, `409` if already prescribed. |
| GET | `/prescriptions/my-exercises` | patient | — | the caller's prescriptions |
| GET | `/prescriptions/patient/{patient_id}` | physiatrist | — | that patient's prescriptions. `403` if not assigned. |

## Attempts: `/attempts`

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/attempts/batch` | patient, admin | `{exercise_id, is_idealized?, frames: [...], meta?: {...}}` | `Attempt`. A patient must be prescribed the exercise (`403`). An admin only needs the exercise to exist (`404`), and the attempt is stored with `patient_id = null`. |
| POST | `/attempts/begin` | patient | `{exercise_id, is_idealized?}` | `{attempt_id}` (hex string). Requires a prescription. |
| WS | `/attempts/{attempt_id}/stream?token=<jwt>` | token (in query) | JSON frame per message | `{"ack": <frame count>}` per frame. Close codes are `4401`, `4403` and `4404`. |
| POST | `/attempts/{attempt_id}/end` | patient (owner) | `{meta?}` | `Attempt`. `404` if not in progress or expired, `403` if another patient owns it. |
| GET | `/attempts/{attempt_id}` | any | — | `Attempt` (integer id). A patient can see only their own. A physiatrist needs an assignment. |
| GET | `/attempts?exercise_id=&patient_id=` | any | — | list. Patients always get their own, and `patient_id` is ignored. Physiatrists **must** pass `patient_id` (`400`) and be assigned to that patient. |

`Attempt` has the fields `{id, exercise_id, patient_id, is_idealized, created_at, frames, meta, features}`.
`features` is always `null` until server-side feature extraction exists.

> Admins calling `GET /attempts` fall into the physiatrist branch and need an
> assignment, so in practice they can't list attempts. Idealized attempts
> (with `patient_id` null) can't be read back through the API at all yet.

## Typical setup sequence

```bash
E=http://localhost:8000

# exercise (no auth needed today)
curl -X POST $E/exercises -H 'Content-Type: application/json' \
  -d '{"exercise_id":"piano_isolated_press","display_name":"Piano Press"}'

# accounts (server-side path; the interface signup also works)
curl -X POST $E/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"doc@example.com","password":"secret123","role":"physiatrist","full_name":"Dr Doc"}'
curl -X POST $E/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"pat@example.com","password":"secret123","role":"patient","full_name":"Pat"}'
# note the patient's "id" from the response

DOC=$(curl -s -X POST $E/auth/login -d 'username=doc@example.com&password=secret123' | jq -r .access_token)

curl -X POST $E/assignments -H "Authorization: Bearer $DOC" -H 'Content-Type: application/json' \
  -d '{"patient_id":"<PATIENT_UUID>"}'
curl -X POST $E/prescriptions -H "Authorization: Bearer $DOC" -H 'Content-Type: application/json' \
  -d '{"patient_id":"<PATIENT_UUID>","exercise_id":"piano_isolated_press"}'
```

The patient can now log in at `/patient` → **Piano Press**, and finished
sessions will be saved.
