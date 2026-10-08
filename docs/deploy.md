# Deploying for free

| Part | Host | Free-tier limits |
|---|---|---|
| Interface (Next.js) | Vercel Hobby (non-commercial use) | none that matter here |
| Engine (FastAPI) | Render free web service (`render.yaml`, `engine/Dockerfile`) | sleeps after ~15 min idle, first request takes 30-60 s |
| Postgres + Auth | Supabase free | 500 MB database, project pauses after 7 days of inactivity |
| Email | Resend free | 100 mails/day; other people's addresses need a verified domain |

All camera and hand tracking runs in the browser. Pages are HTTPS on every host, which the camera needs.

## 1. Supabase (already created)
- **Database URL**: Project Settings > Database > Connection string > **Session pooler**. Use it as
  `ENGINE_DATABASE_URL` with the `postgresql+psycopg://` scheme (the direct connection is IPv6-only, which Render's free tier can't reach).
- Tables are created on engine start (`init_db`). Register the exercises once, e.g. with the admin UI or SQL:
  `piano_isolated_press`, `pinch_flight` (see docs/api.md `POST /exercises`). Column `patientexercise.hand` must exist
  (`ALTER TABLE patientexercise ADD COLUMN IF NOT EXISTS hand VARCHAR`) on a database created before it was added.
- **Authentication > URL Configuration**: Site URL = your Vercel URL; add `https://<vercel-url>/**` to the redirect allow-list.
- Custom SMTP (Resend) and the branded templates: `engine/supabase/templates`, see the earlier setup.

## 2. Engine on Render
1. Push the repo to GitHub. Render > New > **Blueprint** > pick the repo (it reads `render.yaml`).
2. Fill the secrets it asks for:

   | Variable | Value |
   |---|---|
   | `ENGINE_DATABASE_URL` | the session-pooler URL above |
   | `ENGINE_SUPABASE_URL` / `_PUBLISHABLE_KEY` / `_SERVICE_ROLE_KEY` | from Supabase (legacy service_role JWT) |
   | `ENGINE_CORS_ORIGINS` | `https://<your>.vercel.app` (comma-separate several) |
   | `ENGINE_INVITE_REDIRECT_URL` | `https://<your>.vercel.app/accept-invite` |

3. Check `https://<engine>.onrender.com/health` returns `{"status":"ok",...}`.

(Cloud Run works with the same Dockerfile: `gcloud run deploy --source engine --allow-unauthenticated`, same variables.)

## 3. Interface on Vercel
1. Vercel > New Project > the repo, **Root Directory = `interface`**.
2. Environment variables:
   `NEXT_PUBLIC_ENGINE_URL` = the Render URL, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
3. Deploy, then put the final URL into the Supabase Site URL and the Render `ENGINE_CORS_ORIGINS`/`ENGINE_INVITE_REDIRECT_URL`.

## 4. Keeping it alive
- **Render sleep**: ping `https://<engine>/health` every 5-10 min with a free monitor (UptimeRobot, cron-job.org). Or accept the first-request delay.
- **Supabase pause**: any traffic counts; the same monitor hitting the engine's `/health` touches Postgres too.

## 5. Staying under 500 MB
A round's raw frames are about 3 MB. The engine therefore stores patient rounds **slim** (only the fields the features read,
`engine/retention.py`; `ENGINE_TRIM_PATIENT_FRAMES=false` turns it off). Reference recordings stay in full. To reclaim more:

```bash
cd engine
python -m engine.retention --days 30            # dry run: how much would be freed
python -m engine.retention --days 30 --apply    # empty the frames of patient rounds older than 30 days
```

Features, scores and history stay; only the raw frames of old rounds go.

## Before real patients use it
- The role on signup comes from `user_metadata` (docs/status.md, "Anyone can pick their own role"): fix before opening signups.
- Rotate any key that was ever pasted in chat or printed in a terminal (Resend key, Supabase access token).
- Vercel Hobby is for non-commercial use; clinical or paid use needs a paid plan or another host (Cloudflare Pages is free for commercial use).
