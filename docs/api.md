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
| GET | `/health` | — | `{"status": "ok"\|"degraded", "checks": {"postgres": ...}}` |

## Auth: `/auth`

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/auth/complete-profile` | token | — | `UserOut`. Creates the Profile from the token's `user_metadata.role`/`full_name`. `400` if the role is missing or invalid, `409` if the profile already exists. |
| GET | `/auth/me` | any | — | `UserOut` `{id, email, role, full_name}` |
| PATCH | `/auth/me` | any | `{full_name}` (1 to 80 chars) | updated `UserOut`. Users set their own display name. |
| GET | `/auth/team?role=admin\|physiatrist` | admin | — | members of that role plus pending invites: `{id, email, full_name, role, status: "active"\|"pending", invited_at}`. Pending invites are read from Supabase Auth. |
| DELETE | `/auth/team/{user_id}` | admin | — | `{deleted}`. Revokes a pending invite or removes an active admin/physiatrist, and deletes the Supabase account. `400` for yourself, `409` for the last admin or a physiatrist who still has patients or prescriptions. |
| GET | `/auth/patients` | admin | — | every patient with access info (`last_sign_in_at`, `suspended`, from Supabase Auth), care team, prescribed exercises and activity (`rounds`, `last_round_at`, `active_days_30`, `avg_accuracy`). There is no page-view tracking. |
| POST | `/auth/patients/{id}/access` | admin | `{suspended}` | Suspends or restores sign-in (Supabase ban). Data is kept, and tokens already issued stay valid until they expire. |

## Exercises: `/exercises`

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/exercises` | admin | `{exercise_id, display_name, description?}` | `Exercise`. `409` if the id already exists. |
| GET | `/exercises` | — | — | all exercises |
| GET | `/exercises/{exercise_id}` | — | — | one exercise, or `404` |

`GET` endpoints stay public; creating an exercise requires an admin.

## Analytics: `/analytics`

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/analytics/overview?days=30` | admin | Platform rollup. `totals` (all-time counts), `active_patients` (7 days), `adherence_rate` (share of prescriptions with at least one attempt), `avg_accuracy` and `outcomes` (hits/leaks/misses) over the window, zero-filled `by_day` (rounds and average accuracy), `by_exercise` (prescriptions, patients, rounds, accuracy, score) and `by_physiatrist` (patients, prescriptions, rounds, active patients). Accuracy = `hits / (hits + leaks + misses)` from the attempt's `meta`, so attempts from games that don't report those fields are counted in rounds but not in accuracy. `days` is 1 to 365. |

## Physiatrist dashboards: `/care`

All scoped to the caller's assigned patients. Attempt rows are read without frames.

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/care/overview?days=30` | physiatrist | `patients`, `active_patients` (7 days), `needs_attention`, `adherence_rate`, `avg_accuracy`, `rounds`, zero-filled `by_day`, `outcomes`, the `attention` list (up to 8 patients, most urgent first) and `movers` (patients whose accuracy rose by at least 5 points between the first and second half of their rounds). |
| GET | `/care/patients` | physiatrist | Patient summaries: `status` (`needs_attention`, `on_track`, `new`), `reasons`, `trend`, `prescriptions`, `prescription_ids`, `rounds`, `rounds_7d`, `last_round_at`, `recent_accuracy` (last 3 rounds), `avg_accuracy`. |
| GET | `/care/patients/{id}` | physiatrist | `{summary, prescriptions (with rounds and accuracy per game), attempts (latest 60, no frames), latest_analysis}`. `403` if not assigned. `latest_analysis` is the [analysis](adaptation.md) of the most recent round. |
| DELETE | `/care/patients/{id}` | physiatrist | `{unassigned: true}`. Ends the care relationship, data and prescriptions stay. |

Triage rules (`engine/triage.py`): no prescription, not started 3 days after assignment, no rounds for 7 days (high from 14), recent accuracy under 50%, declining trend, and a plateau under 80% after 6 rounds.

## Prescriptions: `/prescriptions`

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/prescriptions` | physiatrist | `{patient_id, exercise_id}` | `{id, patient_id, exercise_id, prescribed_by_id}`. `403` if the patient isn't assigned to the caller, `404` for an unknown exercise, `409` if already prescribed. |
| GET | `/prescriptions/my-exercises` | patient | — | the caller's prescriptions |
| DELETE | `/prescriptions/{id}` | physiatrist | — | `{removed: true}`. `403` if the patient isn't assigned to the caller. Past attempts stay. |

## Attempts: `/attempts`

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/attempts/batch` | patient, admin | `{exercise_id, is_idealized?, frames: [...], meta?: {...}}` | `Attempt`. A patient must be prescribed the exercise (`403`). An admin only needs the exercise to exist (`404`), and the attempt is stored with `patient_id = null`. |
| GET | `/attempts/references?exercise_id=` | admin | — | idealized attempts as summaries `{id, exercise_id, created_at, frame_count, meta, quality}` (no frames). `quality` is a recording-quality report: `verdict` (`good`/`review`/`poor`), `issues`, detection rate, duration, fps, and for attempts with `meta.target_finger` the target's peak curl and the other fingers' peak while it's pressed. Thresholds match the Piano Press game (0.65 curl, 0.35 isolation). |
| POST | `/attempts/references/delete` | admin | `{ids: [...]}` | `{deleted: n}`. Idealized attempts only, patient attempts are never removed here. |
| DELETE | `/attempts/references/{id}` | admin | — | `{deleted: 1}`, or `404` if it isn't a reference. |
| GET | `/attempts/history?exercise_id=&limit=10` | patient | — | The caller's latest attempts, newest first, as `{id, exercise_id, created_at, meta}` (no frames). Games use it for previous results and to adapt their parameters. |
| GET | `/attempts/next-params?exercise_id=` | patient | — | `Analysis` of the caller's latest attempt, or `null` before the first. `adaptation.next_params` are the game settings the next round should use. |
| POST | `/attempts/analyze` | admin | `{exercise_id, frames, meta?}` | `Analysis` of frames that are not stored (an admin's practice run). |
| GET | `/attempts/{attempt_id}/analysis` | any | — | `Analysis` of a stored attempt, same visibility rules as `GET /attempts/{id}`. See [adaptation.md](adaptation.md). |
| GET | `/attempts/{attempt_id}` | any | — | `Attempt` (integer id). A patient can see only their own. A physiatrist needs an assignment. An admin can read idealized attempts. |
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

# accounts: an admin invites the physiatrist and the physiatrist invites the patient (interface, or POST /auth/invite).
# DOC = the physiatrist's Supabase access token; note the patient's id from GET /care/patients.

curl -X POST $E/prescriptions -H "Authorization: Bearer $DOC" -H 'Content-Type: application/json' \
  -d '{"patient_id":"<PATIENT_UUID>","exercise_id":"piano_isolated_press"}'
```

The patient can now log in at `/patient` → **Piano Press**, and finished
sessions will be saved.

### Prescription hand
`POST /prescriptions` accepts an optional `hand` (`"left"` | `"right"`); `PATCH /prescriptions/{id}/hand` with `{"hand": "left"|"right"|null}` changes it (physiatrist of the patient only).
`hand` is returned by `/prescriptions/my-exercises` and `/care/patients/{id}`. `null` means the game asks the patient before every round.
Column `patientexercise.hand` was added by hand (`ALTER TABLE patientexercise ADD COLUMN hand VARCHAR`); there is no migration tool yet.
