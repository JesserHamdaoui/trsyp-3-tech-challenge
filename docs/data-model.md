# Data model

Defined in `engine/engine/storage/models.py` (SQLModel). Tables are created
with `create_all` on startup. There's no migration tool, so a schema change to
an existing table must be applied by hand.

```
auth.users (Supabase) 1──1 profile
profile 1──* physiatristpatient *──1 profile        (physiatrist ↔ patient)
profile 1──* patientexercise   *──1 exercise         (prescription)
exercise 1──* attempt *──0..1 profile                (patient_id null = idealized/admin)
```

## `profile`

The app-side companion to a Supabase `auth.users` row, sharing its UUID.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | same as `auth.users.id`, never generated locally |
| `email` | str, unique, indexed | |
| `role` | `physiatrist` \| `patient` \| `admin`, indexed | |
| `full_name` | str | default `""` |
| `created_at` | timestamptz | |

## `physiatristpatient`

The assignment table. A row here is the **only** thing that lets a
physiatrist see a patient's data.

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | |
| `physiatrist_id` | UUID FK → profile | indexed |
| `patient_id` | UUID FK → profile | indexed |
| `assigned_at` | timestamptz | |

Unique on `(physiatrist_id, patient_id)`.

## `exercise`

A global catalog shared by every patient, with one reference model per exercise.

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | |
| `exercise_id` | str, unique | slug used everywhere else, e.g. `piano_isolated_press`, `fist_close` |
| `display_name` | str | |
| `description` | str | |
| `created_at` | timestamptz | |

## `patientexercise`

The prescription table. A row here is the **only** thing that lets a patient
submit attempts for an exercise.

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | |
| `patient_id` | UUID FK → profile | |
| `exercise_id` | str FK → exercise.exercise_id | |
| `prescribed_by_id` | UUID FK → profile | the physiatrist |
| `assigned_at` | timestamptz | |

Unique on `(patient_id, exercise_id)`.

## `attempt`

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | |
| `exercise_id` | str FK → exercise.exercise_id | indexed |
| `patient_id` | UUID FK → profile, nullable | null for admin/idealized attempts |
| `is_idealized` | bool, indexed | reference performance |
| `created_at` | timestamptz, indexed | |
| `frames` | JSONB | list of [frame records](frame-schema.md). The engine treats it as opaque. |
| `meta` | JSONB | game-supplied context, e.g. `{score, hits, leaks, misses}` from Piano Press |
| `features` | JSONB, nullable | reserved for server-side feature extraction (not implemented) |

