"use client";

/**
 * Piano game: webcam capture, MediaPipe Hand Landmarker (WASM), and the 3D
 * hand twin all run client-side, no server round trip for the control loop
 * -- a prior WebRTC-based approach (browser -> Python cv_server -> back)
 * was tried and dropped for latency; this in-browser path won on both
 * latency and feel.
 *
 * Every detected-hand frame is built into the same record schema as the
 * idealized admin-submitted attempts already seeded on the engine
 * (handFeatures.ts's buildFrameRecord, a faithful port of cv-poc's
 * features.py), accumulated for the session, and submitted in one
 * POST /attempts/batch call when the round ends -- so patient attempts
 * are directly comparable to the idealized reference, no server-side
 * reprocessing step needed.
 *
 * The game owns the whole screen. A round goes intro (previous results + the
 * parameters about to be used) -> camera warm-up -> countdown -> play ->
 * outro animation -> results (this round, vs the previous one, and how the
 * parameters adapt for the next attempt).
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import HandTwin3D, { HandTwin3DHandle } from "@/components/HandTwin3D";
import SettingMeter from "@/components/games/SettingMeter";
import { Delta, DraggablePip, FINGER_COLOR, Mini, OUTRO_MS, OutroScreen, PIP_W, TREND_TEXT, fingerStatus, pct, starsFor } from "@/components/games/shared";
import { ChevronLeft, ChevronRight, Target, CircleCheck, CircleX, Droplets, Fingerprint, Gauge, Hand as HandIcon, ListMusic, Timer, type LucideIcon, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, GripHorizontal, Minus, Play, RotateCcw, Star, X } from "lucide-react";
import { Progress } from "@ark-ui/react/progress";
import { Carousel } from "@ark-ui/react/carousel";
import { supabase } from "@/lib/supabase";
import {
  analyzeAttempt,
  getAttemptAnalysis,
  getAttemptHistory,
  getNextParams,
  listMyExercises,
  submitAttemptBatch,
  submitReferenceAttempt,
  type Analysis,
  type Hand,
} from "@/lib/engine";
import Spinner, { BusyLabel } from "@/components/Spinner";
import { playHit, playLeak, playMiss, unlockAudio } from "@/lib/pianoSound";
import {
  allCurls,
  buildFrameRecord,
  emptyFrameRecord,
  Finger,
  FingerTrack,
  FINGER_NAMES,
  FrameRecord,
  HandTrack,
} from "@/lib/handFeatures";
import {
  ACTIVE_FINGERS,
  DEFAULT_PARAMS,
  FINGER_NOTE,
  GameParams,
  GameState,
  NumericParamKey,
  PARAM_LABELS,
  RoundStats,
  createGame,
  startRound,
  maybeSpawn,
  updateGame,
  noteProgress,
  currentPromptFinger,
  normalizeParams,
  paramsFromMeta,
  roundAccuracy,
} from "@/lib/pianoGame";

const EXERCISE_ID = "piano_isolated_press";

type Phase = "intro" | "loading" | "countdown" | "running" | "outro" | "results" | "error";

/** "practice" is an admin trying the game: nothing is saved.
 * "patient" saves a normal attempt; "reference" is an admin recording an
 * idealized demonstration (stored with no patient, used as the exercise's reference). */
export type PianoMode = "patient" | "reference" | "practice";

interface PastRound extends RoundStats {
  params: GameParams | null;
  at: string | null;
}

interface RoundResult {
  stats: RoundStats;
  params: GameParams;
  prev: PastRound | null;
  total: number;
}


const num = (v: unknown) => (typeof v === "number" ? v : 0);

function pastFromMeta(meta: Record<string, unknown>, at: string): PastRound {
  return {
    hits: num(meta.hits),
    leaks: num(meta.leaks),
    misses: num(meta.misses),
    score: num(meta.score),
    params: paramsFromMeta(meta),
    at,
  };
}

const fmt = (v: number, digits: number) => (digits ? v.toFixed(digits) : String(Math.round(v)));

export default function PianoGame({ mode = "patient", backHref = "/patient" }: { mode?: PianoMode; backHref?: string }) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [error, setError] = useState<string | null>(null);
  const [game, setGame] = useState<GameState>(createGame());
  const [fps, setFps] = useState(0);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outroDone, setOutroDone] = useState(false);
  const [countdown, setCountdown] = useState(3);

  const [history, setHistory] = useState<PastRound[]>([]); // newest first
  const [historyLoading, setHistoryLoading] = useState(mode === "patient");
  const [prescribed, setPrescribed] = useState(true); // only a patient needs one
  // which hand plays: fixed by the physiatrist when they set it, otherwise asked before every round
  const [assignedHand, setAssignedHand] = useState<Hand | null>(null);
  const [pickedHand, setPickedHand] = useState<Hand | null>(null);
  const hand = assignedHand ?? pickedHand;
  const handRef = useRef<Hand | null>(null);
  handRef.current = hand;
  const [params, setParams] = useState<GameParams>(DEFAULT_PARAMS);
  const [result, setResult] = useState<RoundResult | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [whyParams, setWhyParams] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const twinHandleRef = useRef<HandTwin3DHandle | null>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const curlsRef = useRef<Partial<Record<Finger, number>>>({});
  const gameRef = useRef<GameState>(game);
  const rafRef = useRef<number | null>(null);
  const lastFpsSampleRef = useRef<{ t: number; count: number }>({ t: 0, count: 0 });

  const framesRef = useRef<FrameRecord[]>([]);
  const frameIdxRef = useRef(0);
  const fingerTracksRef = useRef<Record<Finger, FingerTrack> | null>(null);
  const handTrackRef = useRef<HandTrack | null>(null);
  const accessTokenRef = useRef<string | null>(null);
  const soundedNoteIdsRef = useRef<Set<number>>(new Set());
  const noteEventsRef = useRef<{ finger: Finger; hit_at_ms: number; judged_at_ms: number; result: string }[]>([]);
  const handSeenAtRef = useRef(0);
  const finishingRef = useRef(false);
  const finishRef = useRef<() => void>(() => {});
  const historyRef = useRef<PastRound[]>([]);
  const paramsRef = useRef<GameParams>(DEFAULT_PARAMS);

  gameRef.current = game;
  historyRef.current = history;
  paramsRef.current = params;

  // the twin and the lanes follow the chosen hand (a left hand mirrors both: thumb on the right)
  useEffect(() => {
    twinHandleRef.current?.setHand(hand);
  }, [hand, phase]);

  // previous attempts -> the parameters this attempt starts with
  useEffect(() => {
    if (mode !== "patient") return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) return;
        const [items, next, mine] = await Promise.all([
          getAttemptHistory(token, EXERCISE_ID, 10),
          getNextParams(token, EXERCISE_ID).catch(() => null),
          listMyExercises(token).catch(() => null),
        ]);
        if (cancelled) return;
        if (mine) {
          setPrescribed(mine.some((m) => m.exercise_id === EXERCISE_ID));
          setAssignedHand(mine.find((m) => m.exercise_id === EXERCISE_ID)?.hand ?? null);
        }
        setHistory(items.map((a) => pastFromMeta(a.meta, a.created_at)));
        // the engine decides this round's settings from the last attempt's analysis
        if (next?.adaptation) {
          setParams(normalizeParams(next.adaptation.next_params));
          setWhyParams(next.adaptation.rationale);
        }
      } catch (err) {
        console.error("could not load attempt history", err);
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const releaseCamera = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
  }, []);

  /** Stops capture and, outside practice mode, uploads the recorded frames. */
  const stop = useCallback(
    async (meta?: Record<string, unknown>) => {
      releaseCamera();

      const frames = framesRef.current;
      const accessToken = accessTokenRef.current;
      framesRef.current = [];
      accessTokenRef.current = null;

      if (frames.length > 0 && accessToken && meta) {
        setSubmitting(true);
        let savedId: number | null = null;
        try {
          if (mode === "reference") {
            const saved = await submitReferenceAttempt(accessToken, EXERCISE_ID, frames, meta);
            savedId = saved.id;
            setSaveNote(`Saved as reference #${saved.id} (${frames.length} frames).`);
          } else if (mode === "patient") {
            const saved = await submitAttemptBatch(accessToken, EXERCISE_ID, frames, meta);
            savedId = saved.id;
            setSaveNote("Round saved to your history.");
          }
        } catch (err) {
          console.warn("failed to submit attempt", err);
          setError(err instanceof Error ? err.message : "Could not save this round.");
        }
        try {
          const a =
            savedId !== null
              ? await getAttemptAnalysis(accessToken, savedId)
              : mode === "practice"
                ? await analyzeAttempt(accessToken, EXERCISE_ID, frames, meta)
                : null;
          if (a) {
            setAnalysis(a);
            if (a.adaptation) {
              setParams(normalizeParams(a.adaptation.next_params));
              setWhyParams(a.adaptation.rationale);
            }
          }
        } catch (err) {
          console.warn("analysis failed", err);
          setAnalysisError(err instanceof Error ? err.message : "Could not analyse this round.");
        } finally {
          setSubmitting(false);
        }
      }
    },
    [mode, releaseCamera]
  );

  const start = useCallback(async () => {
    setError(null);
    setSaveNote(null);
    setResult(null);
    setAnalysis(null);
    setAnalysisError(null);
    noteEventsRef.current = [];
    finishingRef.current = false;
    setPhase("loading");
    unlockAudio();
    try {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) throw new Error("Not logged in.");
      accessTokenRef.current = accessToken;

      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      );
      const landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: "/hand_landmarker.task", delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 1,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      });
      landmarkerRef.current = landmarker;

      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      framesRef.current = [];
      frameIdxRef.current = 0;
      const fingerTracks = {} as Record<Finger, FingerTrack>;
      for (const name of FINGER_NAMES) fingerTracks[name] = new FingerTrack();
      fingerTracksRef.current = fingerTracks;
      handTrackRef.current = new HandTrack();
      soundedNoteIdsRef.current = new Set();

      setGame(createGame(paramsRef.current));
      setCountdown(3);
      setPhase("countdown");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start.");
      setPhase("error");
      stop();
    }
  }, [stop]);

  // 3-2-1 then the round starts
  useEffect(() => {
    if (phase !== "countdown") return;
    const t = setTimeout(() => {
      if (countdown > 1) {
        setCountdown(countdown - 1);
      } else {
        setGame((g) => startRound(g, performance.now()));
        setPhase("running");
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [phase, countdown]);

  const finishRound = useCallback(() => {
    if (finishingRef.current) return;
    finishingRef.current = true;

    const g = gameRef.current;
    const used = g.params;
    const stats: RoundStats = { hits: g.hits, leaks: g.leaks, misses: g.misses, score: g.score };
    const prev = historyRef.current[0] ?? null;

    setResult({ stats, params: used, prev, total: used.sequenceLength });
    setHistory((h) => [{ ...stats, params: used, at: new Date().toISOString() }, ...h]);
    setOutroDone(false);
    setPhase("outro");
    setTimeout(() => setOutroDone(true), OUTRO_MS);
    void stop({ ...stats, params: used, notes: noteEventsRef.current, hand: handRef.current });
  }, [stop]);
  finishRef.current = finishRound;

  useEffect(() => {
    if (phase === "outro" && outroDone && !submitting) setPhase("results");
  }, [phase, outroDone, submitting]);

  // game loop
  useEffect(() => {
    if (phase !== "running") return;

    const tick = () => {
      const video = videoRef.current;
      const landmarker = landmarkerRef.current;
      const fingerTracks = fingerTracksRef.current;
      const handTrack = handTrackRef.current;
      const nowMs = performance.now();

      if (video && landmarker && fingerTracks && handTrack && video.readyState >= 2) {
        const result = landmarker.detectForVideo(video, nowMs);
        const w = video.videoWidth;
        const h = video.videoHeight;
        frameIdxRef.current += 1;

        if (result.landmarks.length > 0) {
          const landmarks = result.landmarks[0] as NormalizedLandmark[];
          curlsRef.current = allCurls(landmarks, w, h);
          handSeenAtRef.current = nowMs;
          const highlight = currentPromptFinger(gameRef.current);
          twinHandleRef.current?.update(curlsRef.current, highlight, { landmarks, w, h });

          const record = buildFrameRecord(
            landmarks,
            w,
            h,
            nowMs / 1000,
            frameIdxRef.current,
            "Unknown",
            0.9,
            fingerTracks,
            handTrack
          );
          framesRef.current.push(record);
        } else {
          curlsRef.current = {};
          // a single dropped detection shouldn't snap the twin open: hold its pose briefly
          if (nowMs - handSeenAtRef.current > 400) twinHandleRef.current?.update({}, currentPromptFinger(gameRef.current), null);
          framesRef.current.push(emptyFrameRecord(nowMs / 1000, frameIdxRef.current));
        }
      }

      lastFpsSampleRef.current.count += 1;
      if (nowMs - lastFpsSampleRef.current.t >= 1000) {
        setFps(lastFpsSampleRef.current.count);
        lastFpsSampleRef.current = { t: nowMs, count: 0 };
      }

      const nextGame = updateGame(maybeSpawn(gameRef.current, nowMs), nowMs, curlsRef.current);

      for (const note of nextGame.notes) {
        if (note.judged && !soundedNoteIdsRef.current.has(note.id)) {
          soundedNoteIdsRef.current.add(note.id);
          if (note.result) {
            noteEventsRef.current.push({
              finger: note.finger,
              hit_at_ms: Math.round(note.hitAtMs),
              judged_at_ms: Math.round(nowMs),
              result: note.result,
            });
          }
          if (note.result === "hit") playHit(note.finger);
          else if (note.result === "leak") playLeak(note.finger);
          else if (note.result === "miss") playMiss();
        }
      }

      gameRef.current = nextGame;
      setGame(nextGame);
      draw(canvasRef.current, nextGame, nowMs, curlsRef.current, lanesFor(handRef.current));

      if (nextGame.finished) {
        finishRef.current();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [phase]);

  // canvas follows the viewport; redraw the idle lanes whenever the game isn't ticking
  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const fit = () => {
      canvas.width = stage.clientWidth;
      canvas.height = stage.clientHeight;
      if (phase !== "running") draw(canvas, createGame(), performance.now(), {}, lanesFor(handRef.current));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [phase, hand]);

  useEffect(() => {
    return () => {
      releaseCamera();
    };
  }, [releaseCamera]);

  const quit = () => {
    framesRef.current = [];
    releaseCamera();
  };

  const nextAttempt = () => {
    setPickedHand(null); // asked again every round
    setError(null);
    setSaveNote(null);
    setResult(null);
    setAnalysis(null);
    setAnalysisError(null);
    setGame(createGame(paramsRef.current));
    setPhase("intro");
  };

  const notesTotal = game.params.sequenceLength;
  const notesDone = Math.min(game.spawned, notesTotal);
  const label =
    mode === "reference" ? "Recording a reference" : mode === "practice" ? "Practice run" : "Today's round";

  return (
    <div className="game-root">
      <div ref={stageRef} className="game-stage">
        <canvas ref={canvasRef} />
      </div>

      {(phase === "running" || phase === "countdown") && (
        <div className="game-hud">
          <a href={backHref} onClick={quit} className="btn btn-ghost" aria-label="Quit without saving">
            <X size={18} strokeWidth={3} /> Quit
          </a>
          <Progress.Root value={notesDone} max={notesTotal || 1} style={{ flex: "1 1 240px" }}>
            <Progress.Track className="progress-track">
              <Progress.Range className="progress-range" />
            </Progress.Track>
          </Progress.Root>
          <div className="pill">
            <span>Score</span>
            <b>{game.score}</b>
          </div>
          <div className="pill">
            <span>Perfect</span>
            <b style={{ color: "var(--mint)" }}>{game.hits}</b>
          </div>
          <div className="pill">
            <span>Leaky</span>
            <b style={{ color: "var(--sun)" }}>{game.leaks}</b>
          </div>
          <div className="pill">
            <span>Missed</span>
            <b style={{ color: "var(--coral)" }}>{game.misses}</b>
          </div>
          <div className="pill">
            <span>FPS</span>
            <b>{fps}</b>
          </div>
          {phase === "running" && (
            <button onClick={finishRound} className="btn btn-danger">
              Finish round
            </button>
          )}
        </div>
      )}

      <DraggablePip hidden={phase === "results" || phase === "outro"}>
        <HandTwin3D width={PIP_W} height={PIP_W} handleRef={twinHandleRef} />
      </DraggablePip>

      {/* video element stays mounted (MediaPipe reads frames from it) but hidden -- the 3D twin is the visible feedback */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
      />

      {phase === "countdown" && (
        <div style={{ position: "absolute", inset: 0, zIndex: 4, display: "grid", placeItems: "center", pointerEvents: "none" }}>
          <div key={countdown} className="countdown-num">
            {countdown}
          </div>
        </div>
      )}

      {phase === "intro" && (
        <IntroScreen
          mode={mode}
          label={label}
          backHref={backHref}
          history={history}
          historyLoading={historyLoading}
          params={params}
          why={whyParams}
          prescribed={prescribed}
          hand={hand}
          handLocked={assignedHand !== null}
          onHand={setPickedHand}
          onStart={start}
        />
      )}

      {phase === "loading" && (
        <div className="game-screen">
          <Spinner size={48} />
          <p className="display" style={{ fontSize: "1.6rem" }}>
            Warming up the camera and hand tracker...
          </p>
          <p className="muted-on-dark">Allow camera access if your browser asks.</p>
        </div>
      )}

      {phase === "error" && (
        <div className="game-screen">
          <p className="display" style={{ fontSize: "2rem" }}>Couldn&apos;t start</p>
          {error && <p className="form-error" style={{ maxWidth: 520 }}>{error}</p>}
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <a href={backHref} className="btn btn-outline">Exit</a>
            <button onClick={() => setPhase("intro")} className="btn btn-go">Try again</button>
          </div>
        </div>
      )}

      {phase === "outro" && result && <OutroScreen stats={result.stats} total={result.total} saving={submitting} />}

      {phase === "results" && result && (
        <ResultsScreen
          mode={mode}
          result={result}
          analysis={analysis}
          analysisError={analysisError}
          saveNote={saveNote}
          error={error}
          backHref={backHref}
          onNext={nextAttempt}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- screens */

function IntroScreen({
  mode,
  label,
  backHref,
  history,
  historyLoading,
  params,
  why,
  prescribed,
  hand,
  handLocked,
  onHand,
  onStart,
}: {
  mode: PianoMode;
  label: string;
  backHref: string;
  history: PastRound[];
  historyLoading: boolean;
  params: GameParams;
  why: string | null;
  prescribed: boolean;
  hand: Hand | null;
  handLocked: boolean;
  onHand: (h: Hand) => void;
  onStart: () => void;
}) {
  const last = history[0];
  const best = history.reduce((m, h) => Math.max(m, h.score), 0);
  const recent = history.slice(0, 8).reverse();
  const rule =
    mode === "reference"
      ? "Play it the way patients should. This round is saved as the idealized reference."
      : mode === "practice"
        ? "Practice run. Nothing you do here is saved."
        : "Curl each finger to its note as it hits the line. Only the glowing finger should move!";

  return (
    <div className="game-screen">
      <div className="falling-notes" aria-hidden>
        {lanesFor(hand).map((f, i) => (
          <i key={f} style={{ ["--x" as string]: `${12 + i * 19}%`, ["--c" as string]: FINGER_COLOR[f], ["--d" as string]: `${i * 0.9}s` }} />
        ))}
      </div>

      <a href={backHref} className="eyebrow muted-on-dark" style={{ position: "absolute", top: "1.25rem", left: "1.5rem", zIndex: 2 }}>
        <ArrowLeft size={14} strokeWidth={3} style={{ verticalAlign: "-2px" }} /> Exit game
      </a>

      <p className="eyebrow rise" style={{ color: "var(--sun)" }}>{label}</p>
      <h1 className="game-title display">Piano Press</h1>
      <p className="muted-on-dark rise" style={{ ["--i" as string]: 3, maxWidth: 520, textAlign: "center", fontSize: "1.1rem" }}>
        {rule}
      </p>

      <div className="game-panel rise" style={{ ["--i" as string]: 4 }}>
        <div className="card">
          <p className="field-label" style={{ marginBottom: "0.6rem" }}>Previous attempts</p>
          {historyLoading ? (
            <div style={{ display: "grid", gap: "0.5rem" }}>
              <div className="skeleton" style={{ height: 26, width: "60%" }} />
              <div className="skeleton" style={{ height: 56 }} />
            </div>
          ) : last ? (
            <>
              <div style={{ display: "flex", gap: "1.5rem", marginBottom: "0.8rem", flexWrap: "wrap" }}>
                <Mini label="Last accuracy" value={pct(roundAccuracy(last))} />
                <Mini label="Last score" value={String(last.score)} />
                <Mini label="Best score" value={String(best)} />
                <Mini label="Attempts" value={String(history.length)} />
              </div>
              <div className="bar-strip" aria-label="Accuracy of recent attempts">
                {recent.map((h, i) => (
                  <i key={i} style={{ ["--h" as string]: `${Math.max(6, roundAccuracy(h) * 100)}%` }} title={pct(roundAccuracy(h))} />
                ))}
              </div>
              <p style={{ fontSize: "0.78rem", color: "var(--foreground-muted)", marginTop: "0.35rem" }}>
                Accuracy per attempt, latest in orange.
              </p>
            </>
          ) : (
            <p style={{ color: "var(--foreground-muted)" }}>
              {mode === "patient" ? "No attempts yet. This one sets your starting point." : "Nothing yet in this session."}
            </p>
          )}
        </div>

        <div className="card">
          <p className="field-label" style={{ marginBottom: "0.6rem" }}>Game settings this round</p>
          <div className="setting-grid">
            {(Object.keys(PARAM_LABELS) as NumericParamKey[]).map((k) => {
              const m = PARAM_LABELS[k];
              const Icon = SETTING_META[k].icon;
              return (
                <div key={k} className="setting-tile" style={{ ["--c" as string]: SETTING_META[k].color }}>
                  <span className="setting-icon">
                    <Icon size={22} strokeWidth={2.6} />
                  </span>
                  <div>
                    <p className="setting-label">{m.label}</p>
                    <SettingMeter k={k} value={params[k]} />
                    <p className="setting-hint">{SETTING_META[k].hint}</p>
                  </div>
                </div>
              );
            })}
          </div>
          {params.focusFinger && (
            <div className="setting-tile" style={{ ["--c" as string]: "var(--brand)", marginTop: "0.7rem" }}>
              <span className="setting-icon"><Target size={22} strokeWidth={2.6} /></span>
              <div>
                <p className="setting-label">Focus finger</p>
                <p className="setting-value" style={{ textTransform: "capitalize" }}>{params.focusFinger}</p>
                <p className="setting-hint">Your weakest finger right now, so it shows up more often</p>
              </div>
            </div>
          )}
          <p style={{ fontSize: "0.85rem", color: "var(--foreground-muted)", marginTop: "0.7rem" }}>
            {why ?? `Default settings${last ? "" : " for your first round"}.`}
          </p>
        </div>
      </div>

      {!prescribed && (
        <p className="form-error" style={{ maxWidth: 480, textAlign: "center" }}>
          This game isn&apos;t prescribed to you yet, so rounds can&apos;t be saved. Ask your physiatrist to add it.
        </p>
      )}
      <div className="hand-pick rise" style={{ ["--i" as string]: 5 }} role="radiogroup" aria-label="Which hand are you playing with?">
        <p className="eyebrow">{handLocked ? "Your physiatrist set your hand" : "Which hand are you playing with?"}</p>
        <div>
          {(["left", "right"] as const).map((h) => (
            <button
              key={h}
              role="radio"
              aria-checked={hand === h}
              data-on={hand === h}
              disabled={handLocked && hand !== h}
              onClick={() => onHand(h)}
              className="hand-pick-btn"
            >
              <HandIcon size={22} strokeWidth={2.6} style={h === "left" ? { transform: "scaleX(-1)" } : undefined} />
              {h === "left" ? "Left hand" : "Right hand"}
            </button>
          ))}
        </div>
      </div>
      <button onClick={onStart} disabled={historyLoading || !prescribed || !hand} className="btn btn-go btn-lg rise" style={{ ["--i" as string]: 6, fontSize: "1.4rem" }}>
        <BusyLabel busy={historyLoading} busyText="Loading...">
          <Play size={22} fill="currentColor" /> Start
        </BusyLabel>
      </button>
    </div>
  );
}

const SETTING_META: Record<keyof GameParams, { icon: LucideIcon; color: string; hint: string }> = {
  focusFinger: { icon: Target, color: "var(--brand)", hint: "Weakest finger: shows up more often" },
  focusBoost: { icon: Target, color: "var(--brand)", hint: "" },
  targetCurlThreshold: { icon: HandIcon, color: "var(--brand)", hint: "How far the finger must bend" },
  isolationTolerance: { icon: Fingerprint, color: "var(--lilac-deep, #8a5bd6)", hint: "Movement allowed in other fingers" },
  timingWindowMs: { icon: Timer, color: "var(--sky-deep)", hint: "Time to press around the line" },
  noteFallMs: { icon: Gauge, color: "var(--mint-deep)", hint: "Longer = slower notes" },
  sequenceLength: { icon: ListMusic, color: "var(--coral-deep)", hint: "Notes in this round" },
};

function formatParam(key: string, v: unknown): string {
  if (v === null || v === undefined) return "none";
  if (typeof v === "string") return v.charAt(0).toUpperCase() + v.slice(1);
  const m = PARAM_LABELS[key as NumericParamKey];
  return m ? fmt(Number(v), m.digits) : String(v);
}

function ResultsScreen({
  mode,
  result,
  analysis,
  analysisError,
  saveNote,
  error,
  backHref,
  onNext,
}: {
  mode: PianoMode;
  result: RoundResult;
  analysis: Analysis | null;
  analysisError: string | null;
  saveNote: string | null;
  error: string | null;
  backHref: string;
  onNext: () => void;
}) {
  const { stats, prev, total } = result;
  const stars = starsFor(stats, total);
  const verdict = ["Keep going — every rep counts!", "Nice start!", "Great round!", "Flawless fingers!"][stars];
  const acc = Math.round(roundAccuracy(stats) * 100);
  const prevAcc = prev ? Math.round(roundAccuracy(prev) * 100) : 0;
  const adapt = analysis?.adaptation ?? null;
  const prevA = analysis?.previous ?? null;

  const judged = stats.hits + stats.leaks + stats.misses;
  const outcomes: { label: string; value: number; before: number | null; better: "up" | "down"; color: string; soft: string; icon: LucideIcon }[] = [
    { label: "Perfect", value: stats.hits, before: prev ? prev.hits : null, better: "up", color: "var(--mint-deep)", soft: "var(--mint-soft)", icon: CircleCheck },
    { label: "Leaky", value: stats.leaks, before: prev ? prev.leaks : null, better: "down", color: "var(--sun-deep)", soft: "var(--sun-soft)", icon: Droplets },
    { label: "Missed", value: stats.misses, before: prev ? prev.misses : null, better: "down", color: "var(--coral-deep)", soft: "var(--coral-soft)", icon: CircleX },
  ];
  const changeByKey = new Map((adapt?.changes ?? []).map((c) => [c.key, c]));
  const nextParams = adapt ? normalizeParams(adapt.next_params) : result.params;
  const tone = !adapt || adapt.verdict === "hold" ? "same" : adapt.verdict;
  const series = analysis?.trend.accuracy_series ?? [];

  return (
    <div className="game-screen">
      <p className="eyebrow rise" style={{ color: "var(--sun)" }}>
        {mode === "reference" ? "Reference recorded" : mode === "practice" ? "Practice complete" : "Round complete"}
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: "1.5rem", flexWrap: "wrap", justifyContent: "center" }}>
        <div className="stars" style={{ margin: 0 }} aria-label={`${stars} of 3 stars`}>
          {[0, 1, 2].map((i) => (
            <Star key={i} className="star" data-on={i < stars} style={{ ["--i" as string]: i, width: 48, height: 48 }} fill="currentColor" strokeWidth={1.5} />
          ))}
        </div>
        <div>
          <p className="display" style={{ fontSize: "1.8rem" }}>{verdict}</p>
          <p className="display" style={{ fontSize: "3rem", color: "var(--brand)", lineHeight: 1 }}>
            {stats.score} <span style={{ fontSize: "1.1rem", color: "var(--on-dark-muted)" }}>pts · {acc}% accurate</span>
          </p>
        </div>
      </div>

      <Carousel.Root className="result-carousel rise" slideCount={3} spacing="16px" style={{ ["--i" as string]: 2 }}>
        <Carousel.ItemGroup className="result-slides">
        <Carousel.Item index={0}>
        <div className="card">
          <p className="field-label" style={{ marginBottom: "0.7rem" }}>This round vs. previous</p>

          <div className="result-hero">
            <div>
              <p className="setting-label">Accuracy</p>
              <p className="setting-value" style={{ fontSize: "3rem" }}>{acc}%</p>
            </div>
            {prev ? (
              <div style={{ textAlign: "right" }}>
                <Delta diff={acc - prevAcc} better="up" suffix=" pts" />
                <p className="setting-hint">was {prevAcc}% · score {prev.score} → {stats.score}</p>
              </div>
            ) : (
              <p className="setting-hint" style={{ maxWidth: 190, textAlign: "right" }}>
                First attempt: this round is your baseline.
              </p>
            )}
          </div>

          {judged > 0 && (
            <div className="outcome-bar" role="img" aria-label={`${stats.hits} perfect, ${stats.leaks} leaky, ${stats.misses} missed`}>
              {outcomes.map((o) => o.value > 0 && <i key={o.label} style={{ flexGrow: o.value, background: o.color }} />)}
            </div>
          )}

          <div className="outcome-grid">
            {outcomes.map((o) => {
              const Icon = o.icon;
              return (
                <div key={o.label} className="outcome-tile" style={{ ["--c" as string]: o.color, background: o.soft }}>
                  <Icon size={22} strokeWidth={2.6} style={{ color: o.color }} />
                  <p className="setting-value" style={{ color: o.color }}>{o.value}</p>
                  <p className="setting-label">{o.label}</p>
                  {o.before !== null ? (
                    <>
                      <Delta diff={o.value - o.before} better={o.better} />
                      <p className="setting-hint">was {o.before}</p>
                    </>
                  ) : (
                    <p className="setting-hint">{judged ? pct(o.value / judged) : "-"} of notes</p>
                  )}
                </div>
              );
            })}
          </div>

          {analysis && (
            <div style={{ marginTop: "0.9rem" }}>
              <p className="setting-label" style={{ marginBottom: "0.35rem" }}>
                Trend over {analysis.trend.attempts} attempt{analysis.trend.attempts === 1 ? "" : "s"}: {TREND_TEXT[analysis.trend.direction]}
              </p>
              {series.length > 1 && (
                <div className="bar-strip" aria-label="Accuracy per attempt">
                  {series.slice(-10).map((v, i) => (
                    <i key={i} style={{ ["--h" as string]: `${Math.max(6, v * 100)}%` }} title={pct(v)} />
                  ))}
                </div>
              )}
              {prevA && (prevA.improved.length > 0 || prevA.regressed.length > 0) && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.6rem" }}>
                  {prevA.improved.map((d) => (
                    <span key={d.key} className="delta" data-tone="good"><ArrowUp size={12} strokeWidth={3} />{d.label}</span>
                  ))}
                  {prevA.regressed.map((d) => (
                    <span key={d.key} className="delta" data-tone="bad"><ArrowDown size={12} strokeWidth={3} />{d.label}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        </Carousel.Item>

        <Carousel.Item index={1}>
        <div className="card">
          <p className="field-label" style={{ marginBottom: "0.7rem" }}>How you compare to the ideal</p>
          {analysis && analysis.deviation_score !== null ? (
            <>
              <div className="result-hero">
                <div>
                  <p className="setting-label">Match to reference</p>
                  <p className="setting-value" style={{ fontSize: "3rem" }}>
                    {Math.round(analysis.deviation_score)}<small>/100</small>
                  </p>
                </div>
                <div style={{ textAlign: "right" }}>
                  {prevA?.deviation_delta != null && <Delta diff={Math.round(prevA.deviation_delta)} better="up" suffix=" pts" />}
                  <p className="setting-hint" style={{ maxWidth: 200 }}>
                    {analysis.reference.source === "idealized"
                      ? `vs. ${analysis.reference.attempts} idealized recording${analysis.reference.attempts === 1 ? "" : "s"}`
                      : "vs. built-in targets (no idealized recordings yet)"}
                  </p>
                </div>
              </div>

              <p className="setting-label" style={{ margin: "0.5rem 0 0.35rem" }}>Finger by finger</p>
              <div style={{ display: "grid", gap: "0.45rem" }}>
                {analysis.fingers.map((f) => {
                  const st = fingerStatus(f.badness);
                  return (
                    <div key={f.finger} className="finger-row">
                      <span className="finger-dot" style={{ background: FINGER_COLOR[f.finger as Finger] }} />
                      <span style={{ fontWeight: 800, textTransform: "capitalize", width: 64 }}>{f.finger}</span>
                      <span className="finger-track" aria-hidden>
                        <i style={{ width: `${Math.max(4, 100 - Math.min(100, (f.badness / 3) * 100))}%`, background: st.color }} />
                      </span>
                      <span className="delta" data-tone={st.tone}>{st.text}</span>
                    </div>
                  );
                })}
              </div>

              {analysis.drivers.length > 0 ? (
                <>
                  <p className="setting-label" style={{ margin: "0.9rem 0 0.35rem" }}>What held you back most</p>
                  {analysis.drivers.slice(0, 3).map((d) => (
                    <div key={d.key} className="driver-row">
                      <span className="driver-share">{Math.round(d.share * 100)}%</span>
                      <span>{d.detail}</span>
                    </div>
                  ))}
                </>
              ) : (
                <p className="setting-hint" style={{ marginTop: "0.8rem" }}>Nothing stands out: your movement matches the reference.</p>
              )}
            </>
          ) : (
            <p className="setting-hint">
              {analysisError
                ? `Couldn't compare with the reference: ${analysisError}`
                : "No finger-level data was captured this round, so there's nothing to compare."}
            </p>
          )}
        </div>
        </Carousel.Item>

        <Carousel.Item index={2}>
        <div className="card">
          <p className="field-label" style={{ marginBottom: "0.7rem" }}>Next attempt adapts</p>
          <div className="adapt-banner" data-tone={tone}>
            {tone === "same" ? <Minus size={22} strokeWidth={3} /> : tone === "harder" ? <ArrowUp size={22} strokeWidth={3} /> : <ArrowDown size={22} strokeWidth={3} />}
            <span>
              {!adapt
                ? "No adaptation this time: settings stay the same."
                : adapt.verdict === "hold"
                  ? "Settings hold steady."
                  : adapt.verdict === "harder"
                    ? "Strong results. The game gets harder."
                    : "Tough results. The game eases off."}
            </span>
          </div>
          {adapt && (
            <p className="setting-hint" style={{ margin: "0.5rem 0 0" }}>
              {adapt.rationale} Confidence {Math.round(adapt.confidence * 100)}%.
            </p>
          )}

          <div className="setting-grid" style={{ marginTop: "0.8rem" }}>
            {(Object.keys(PARAM_LABELS) as NumericParamKey[]).map((k) => {
              const m = PARAM_LABELS[k];
              const c = changeByKey.get(k);
              const Icon = SETTING_META[k].icon;
              return (
                <div key={k} className="setting-tile" data-changed={!!c} style={{ ["--c" as string]: SETTING_META[k].color }}>
                  <span className="setting-icon"><Icon size={22} strokeWidth={2.6} /></span>
                  <div>
                    <p className="setting-label">{m.label}</p>
                    <SettingMeter k={k} value={nextParams[k]} from={c ? Number(c.from_value) : undefined} />
                    {c ? (
                      <p className="setting-hint">
                        <span className="delta" data-tone={c.direction === "harder" ? "bad" : "good"}>
                          {c.direction === "harder" ? <ArrowUp size={12} strokeWidth={3} /> : <ArrowDown size={12} strokeWidth={3} />}
                          {c.direction}
                        </span>{" "}
                        {c.reason}
                      </p>
                    ) : (
                      <p className="setting-hint">Unchanged</p>
                    )}
                  </div>
                </div>
              );
            })}
            {(nextParams.focusFinger || changeByKey.has("focusFinger")) && (
              <div className="setting-tile" data-changed={changeByKey.has("focusFinger")} style={{ ["--c" as string]: "var(--brand)" }}>
                <span className="setting-icon"><Target size={22} strokeWidth={2.6} /></span>
                <div>
                  <p className="setting-label">Focus finger</p>
                  <p className="setting-value">
                    {changeByKey.has("focusFinger") && (
                      <>
                        <span className="setting-from">{formatParam("focusFinger", changeByKey.get("focusFinger")!.from_value)}</span>
                        <ArrowRight size={18} strokeWidth={3} style={{ margin: "0 0.25rem", verticalAlign: "-1px" }} />
                      </>
                    )}
                    {formatParam("focusFinger", nextParams.focusFinger)}
                  </p>
                  <p className="setting-hint">{changeByKey.get("focusFinger")?.reason ?? "Appears more often until it matches the reference"}</p>
                </div>
              </div>
            )}
          </div>
        </div>
        </Carousel.Item>
        </Carousel.ItemGroup>

        <Carousel.Control className="result-nav">
          <Carousel.PrevTrigger className="icon-btn result-arrow" aria-label="Previous">
            <ChevronLeft size={22} strokeWidth={3} />
          </Carousel.PrevTrigger>
          <Carousel.IndicatorGroup className="result-tabs">
            {["This round", "Vs. the ideal", "Next attempt"].map((label, n) => (
              <Carousel.Indicator key={label} index={n} className="result-tab">
                {label}
              </Carousel.Indicator>
            ))}
          </Carousel.IndicatorGroup>
          <Carousel.NextTrigger className="icon-btn result-arrow" aria-label="Next">
            <ChevronRight size={22} strokeWidth={3} />
          </Carousel.NextTrigger>
        </Carousel.Control>
      </Carousel.Root>

      {saveNote && <p className="form-success">{saveNote}</p>}
      {error && <p className="form-error">{error}</p>}

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", justifyContent: "center" }}>
        <a href={backHref} className="btn btn-outline">
          {mode === "reference" ? "Reference attempts" : mode === "practice" ? "Exercises" : "Games"}
        </a>
        <button onClick={onNext} className="btn btn-go btn-lg">
          <RotateCcw size={20} strokeWidth={3} /> Next attempt
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- canvas */

/** Lane order, left to right. A right hand (palm toward the screen, selfie view) has the thumb on the left; a left hand mirrors it. */
const lanesFor = (hand: Hand | null): Finger[] => (hand === "left" ? [...ACTIVE_FINGERS].reverse() : ACTIVE_FINGERS);

function draw(
  canvas: HTMLCanvasElement | null,
  game: GameState,
  nowMs: number,
  curls: Partial<Record<Finger, number>>,
  lanes: Finger[]
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const playW = Math.min(W, 980);
  const x0 = (W - playW) / 2;
  const margin = 24;
  const laneW = (playW - 2 * margin) / lanes.length;
  const targetY = H - 150;

  ctx.fillStyle = "#05232c";
  ctx.fillRect(0, 0, W, H);

  lanes.forEach((finger, i) => {
    const lx = x0 + margin + laneW * i;
    ctx.fillStyle = i % 2 ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.07)";
    ctx.fillRect(lx, 0, laneW, H);

    ctx.fillStyle = FINGER_COLOR[finger];
    ctx.font = "600 18px Fredoka, system-ui";
    ctx.textAlign = "left";
    ctx.fillText(`${finger.slice(0, 3).toUpperCase()} ${FINGER_NOTE[finger]}`, lx + 10, H - 28);

    const curl = curls[finger] ?? 0;
    const barH = curl * 80;
    ctx.fillStyle = FINGER_COLOR[finger];
    ctx.fillRect(lx + laneW - 22, H - 48 - barH, 14, barH);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 2;
    ctx.strokeRect(lx + laneW - 22, H - 128, 14, 80);
  });

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x0 + margin, targetY);
  ctx.lineTo(x0 + playW - margin, targetY);
  ctx.stroke();
  ctx.lineWidth = 1;

  for (const note of game.notes) {
    const i = lanes.indexOf(note.finger);
    const x = x0 + margin + laneW * i + laneW / 2;
    const progress = noteProgress(note, nowMs);
    const y = progress * targetY;

    let color = FINGER_COLOR[note.finger];
    if (note.result === "hit") color = "#27e0c0";
    else if (note.result === "leak") color = "#ffd84a";
    else if (note.result === "miss") color = "#ff4f8b";

    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.arc(x, y + 5, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}
