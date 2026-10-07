# Rehab Engine — Interface

The Next.js 16 (App Router) web app for patients, physiatrists and admins.
It includes the camera-driven **Piano Press** rehab game.

> This Next.js version has breaking changes compared with older releases.
> See `AGENTS.md`, and read `node_modules/next/dist/docs/` before changing
> framework-level code.

## Run

```bash
npm install
npm run dev        # http://localhost:3000
```

`.env.local`:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable/anon key>
NEXT_PUBLIC_ENGINE_URL=http://localhost:8000
```

The engine must be running and must allow this origin in CORS (it allows
localhost:3000 by default). Piano Press needs camera permission and a
WebGL-capable browser.

## Routes

| Route | Page |
|---|---|
| `/` | Role picker (Patient / Physiatrist / Admin) |
| `/patient` | Login/signup. After login, shows the assigned games (currently a hardcoded list). |
| `/patient/piano` | Piano Press game |
| `/physiatrist` | Login/signup only (dashboard not built yet) |
| `/admin` | Login/signup only (dashboard not built yet) |

## Code map

| File | Purpose |
|---|---|
| `src/components/AuthForm.tsx` | Supabase login and signup. On signup it passes `{role, full_name}` as metadata, then calls the engine's `/auth/complete-profile`. |
| `src/components/HandTwin3D.tsx` | Three.js rigged-hand twin driven by per-finger curl values |
| `src/lib/handFeatures.ts` | Per-frame feature extraction from MediaPipe landmarks (a port of `cv-poc/features.py`) |
| `src/lib/pianoGame.ts` | Pure game state machine: spawn, judge as hit/leak/miss, score |
| `src/lib/pianoSound.ts` | Web Audio tones for hit, leak and miss |
| `src/lib/engine.ts` | Engine API client (`submitAttemptBatch`) |
| `src/lib/supabase.ts` | Supabase browser client |
| `src/app/globals.css` | Design tokens (`--accent-patient`, etc.) and shared classes (`.card`, `.btn`, `.field`) |
| `public/hand_landmarker.task` | MediaPipe hand landmark model |
| `public/simplehand.fbx` | Rigged hand mesh (21 bones) |

See [`../docs/piano-game.md`](../docs/piano-game.md) and
[`../docs/frame-schema.md`](../docs/frame-schema.md).
