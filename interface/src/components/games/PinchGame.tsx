"use client";

/**
 * Pinch Flight: a force-matching game played with a sensor glove (FSR per fingertip + palm IMU).
 *
 * The glove isn't built yet, so the webcam stands in for it: the MediaPipe landmarks go through
 * `CameraGlove` (lib/glove.ts), which turns the thumb-to-fingertip distance into a pinch "force" and the
 * palm's motion into IMU readings, in exactly the packet shape the real glove will stream. This
 * component only ever reads `GlovePacket`s, so replacing the simulator is a one-line change where
 * `CameraGlove` is created.
 *
 * Camera frames still feed the same hand records as Piano Press (detection rate and the
 * finger tracking stay comparable); each record also carries the glove packet that was current when it
 * was captured. Flow: intro -> camera warm-up -> one-off calibration -> countdown -> play -> outro ->
 * results (this round, vs the ideal, what adapts next).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { Carousel } from "@ark-ui/react/carousel";
import { Progress } from "@ark-ui/react/progress";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Anchor, ChevronLeft, ChevronRight, CircleCheck, CircleX, Droplets,
  Dumbbell, Feather, Fingerprint, Hourglass, ListOrdered, Minus, Play, RotateCcw, Ruler, Target, Timer, Waves, Wind, X,
  type LucideIcon,
} from "lucide-react";
import { Meter } from "@/components/games/SettingMeter";
import {
  Delta, FINGER_COLOR, Mini, OUTRO_MS, OutroScreen, TREND_TEXT, fingerStatus, pct, starsFor,
} from "@/components/games/shared";
import Spinner, { BusyLabel } from "@/components/Spinner";
import { supabase } from "@/lib/supabase";
import {
  analyzeAttempt, getAttemptAnalysis, getAttemptHistory, getNextParams, listMyExercises, submitAttemptBatch,
  submitReferenceAttempt, type Analysis,
} from "@/lib/engine";
import { playHit, playLeak, playMiss, unlockAudio } from "@/lib/pianoSound";
import {
  buildFrameRecord, emptyFrameRecord, FINGER_NAMES, FingerTrack, HandTrack, type Finger, type FrameRecord,
} from "@/lib/handFeatures";
import {
  CameraGlove, forces, percentile, type Calibration, type GlovePacket, type GloveSource,
} from "@/lib/glove";
import {
  DEFAULT_PINCH_PARAMS, PINCH_FINGERS, PINCH_LABELS, PINCH_SCALE, activePipe, centreAt, createPinch, inGate,
  normalizePinchParams, pinchAccuracy, pinchParamsFromMeta, pipeRecords, steadied, updatePinch,
  type PinchNumericKey, type PinchParams, type PinchState, type PinchStats,
} from "@/lib/pinchGame";

const EXERCISE_ID = "pinch_flight";

type Phase = "intro" | "loading" | "calibrate" | "countdown" | "running" | "outro" | "results" | "error";
export type PinchMode = "patient" | "reference" | "practice";

interface PastRound extends PinchStats {
  params: PinchParams | null;
  at: string | null;
}

interface RoundResult {
  stats: PinchStats;
  params: PinchParams;
  prev: PastRound | null;
  total: number;
}

const num = (v: unknown) => (typeof v === "number" ? v : 0);
const pastFromMeta = (meta: Record<string, unknown>, at: string): PastRound => ({
  hits: num(meta.hits), leaks: num(meta.leaks), misses: num(meta.misses), score: num(meta.score), params: pinchParamsFromMeta(meta), at,
});

const STALE_MS = 300;
const ZERO = { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 } as Record<Finger, number>;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

const CAL_STEPS = [
  { key: "open", title: "Open your hand", hint: "Spread your fingers and let them relax.", ms: 2200 },
  ...PINCH_FINGERS.map((f) => ({
    key: f, title: `Pinch your ${f} finger`, hint: "Press its tip against your thumb as firmly as is comfortable, and hold.", ms: 3200,
  })),
];

export default function PinchGame({ mode = "patient", backHref = "/patient" }: { mode?: PinchMode; backHref?: string }) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [error, setError] = useState<string | null>(null);
  const [game, setGame] = useState<PinchState | null>(null);
  const [fps, setFps] = useState(0);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outroDone, setOutroDone] = useState(false);
  const [countdown, setCountdown] = useState(3);

  const [history, setHistory] = useState<PastRound[]>([]);
  const [historyLoading, setHistoryLoading] = useState(mode === "patient");
  const [prescribed, setPrescribed] = useState(true);
  const [params, setParams] = useState<PinchParams>(DEFAULT_PINCH_PARAMS);
  const [result, setResult] = useState<RoundResult | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [whyParams, setWhyParams] = useState<string | null>(null);

  const [calibrated, setCalibrated] = useState(false);
  const [calStep, setCalStep] = useState(0);
  const [calProgress, setCalProgress] = useState(0);
  const [calMsg, setCalMsg] = useState<string | null>(null);
  const [calRaw, setCalRaw] = useState(0);
  const [handLost, setHandLost] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFpsSampleRef = useRef<{ t: number; count: number }>({ t: 0, count: 0 });

  const gloveRef = useRef<GloveSource | null>(null);
  const packetRef = useRef<GlovePacket | null>(null);
  const calibRef = useRef<Calibration | null>(null);
  const framesRef = useRef<FrameRecord[]>([]);
  const frameIdxRef = useRef(0);
  const fingerTracksRef = useRef<Record<Finger, FingerTrack> | null>(null);
  const handTrackRef = useRef<HandTrack | null>(null);
  const accessTokenRef = useRef<string | null>(null);
  const handSeenAtRef = useRef(0);
  const finishingRef = useRef(false);
  const finishRef = useRef<() => void>(() => {});
  const historyRef = useRef<PastRound[]>([]);
  const paramsRef = useRef<PinchParams>(DEFAULT_PINCH_PARAMS);
  const gameRef = useRef<PinchState | null>(null);
  const activeFingerRef = useRef<Finger | null>(null);
  const viewRef = useRef<View>({ bird: 0, trail: [], flash: null, handLost: false, active: null, params: DEFAULT_PINCH_PARAMS });
  const judgedRef = useRef<Set<number>>(new Set());
  const calBufRef = useRef<{ rest: Record<string, number[]>; pinch: number[]; elapsed: number; last: number; rest_: Record<string, number> }>({
    rest: {}, pinch: [], elapsed: 0, last: 0, rest_: {},
  });
  const calStepRef = useRef(0);
  const calUiRef = useRef(0);

  gameRef.current = game;
  historyRef.current = history;
  paramsRef.current = params;

  // previous attempts -> the settings this attempt starts with
  useEffect(() => {
    if (mode !== "patient") return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const accessToken = data.session?.access_token;
        if (!accessToken) return;
        const [items, next, mine] = await Promise.all([
          getAttemptHistory(accessToken, EXERCISE_ID, 10),
          getNextParams(accessToken, EXERCISE_ID).catch(() => null),
          listMyExercises(accessToken).catch(() => null),
        ]);
        if (cancelled) return;
        if (mine) setPrescribed(mine.some((m) => m.exercise_id === EXERCISE_ID));
        setHistory(items.map((a) => pastFromMeta(a.meta, a.created_at)));
        if (next?.adaptation) {
          setParams(normalizePinchParams(next.adaptation.next_params));
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
    gloveRef.current?.close();
    gloveRef.current = null;
    packetRef.current = null;
  }, []);

  /** One camera frame: hand landmarks -> glove packet + hand record. Returns the glove packet if fresh. */
  const sense = useCallback((nowMs: number, record: boolean): GlovePacket | null => {
    const video = videoRef.current;
    const landmarker = landmarkerRef.current;
    const fingerTracks = fingerTracksRef.current;
    const handTrack = handTrackRef.current;
    const glove = gloveRef.current as CameraGlove | null;
    if (!video || !landmarker || !fingerTracks || !handTrack || !glove || video.readyState < 2) return null;

    const res = landmarker.detectForVideo(video, nowMs);
    const w = video.videoWidth;
    const h = video.videoHeight;
    frameIdxRef.current += 1;

    if (res.landmarks.length > 0) {
      const landmarks = res.landmarks[0] as NormalizedLandmark[];
      handSeenAtRef.current = nowMs;
      const packet = glove.ingest(landmarks, w, h, nowMs);
      if (record) {
        const rec = buildFrameRecord(landmarks, w, h, nowMs / 1000, frameIdxRef.current, "Unknown", 0.9, fingerTracks, handTrack);
        const cal = calibRef.current;
        if (packet && cal) {
          const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r3(v)]));
          rec.glove = { t: Math.round(packet.t), fsr: round(packet.fsr), force: round(forces(packet, cal)), imu: round({ ...packet.imu }) };
        }
        framesRef.current.push(rec);
      }
      return packet;
    }
    glove.ingest(null, w, h, nowMs);
    if (record) framesRef.current.push(emptyFrameRecord(nowMs / 1000, frameIdxRef.current));
    return null;
  }, []);

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
              setParams(normalizePinchParams(a.adaptation.next_params));
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

  const beginCountdown = useCallback(() => {
    setGame(null);
    setCountdown(3);
    setPhase("countdown");
  }, []);

  const start = useCallback(
    async (recalibrate = false) => {
      setError(null);
      setSaveNote(null);
      setResult(null);
      setAnalysis(null);
      setAnalysisError(null);
      finishingRef.current = false;
      if (recalibrate) {
        calibRef.current = null;
        setCalibrated(false);
      }
      setPhase("loading");
      unlockAudio();
      try {
        const { data } = await supabase.auth.getSession();
        const accessToken = data.session?.access_token;
        if (!accessToken) throw new Error("Not logged in.");
        accessTokenRef.current = accessToken;

        const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
        landmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: "/hand_landmarker.task", delegate: "GPU" },
          runningMode: "VIDEO",
          numHands: 1,
          minHandDetectionConfidence: 0.6,
          minHandPresenceConfidence: 0.6,
          minTrackingConfidence: 0.6,
        });
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        framesRef.current = [];
        frameIdxRef.current = 0;
        const tracks = {} as Record<Finger, FingerTrack>;
        for (const name of FINGER_NAMES) tracks[name] = new FingerTrack();
        fingerTracksRef.current = tracks;
        handTrackRef.current = new HandTrack();
        judgedRef.current = new Set();

        // the only place that knows the glove is simulated
        const glove: GloveSource = new CameraGlove();
        glove.subscribe((p) => {
          packetRef.current = p;
        });
        gloveRef.current = glove;

        if (calibRef.current) {
          beginCountdown();
        } else {
          calStepRef.current = 0;
          calBufRef.current = { rest: {}, pinch: [], elapsed: 0, last: 0, rest_: {} };
          setCalStep(0);
          setCalProgress(0);
          setCalMsg(null);
          setPhase("calibrate");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to start.");
        setPhase("error");
        stop();
      }
    },
    [beginCountdown, stop]
  );

  // calibration: one step at a time, the clock only runs while the glove is reporting
  useEffect(() => {
    if (phase !== "calibrate") return;
    const tick = () => {
      const now = performance.now();
      activeFingerRef.current = CAL_STEPS[calStepRef.current]?.key === "open" ? null : (CAL_STEPS[calStepRef.current]?.key as Finger);
      const packet = sense(now, false);
      const buf = calBufRef.current;
      const dt = buf.last ? Math.min(100, now - buf.last) : 0;
      buf.last = now;
      const step = CAL_STEPS[calStepRef.current];
      setHandLost(!packet);

      if (packet && step) {
        buf.elapsed += dt;
        if (step.key === "open") {
          for (const f of PINCH_FINGERS) (buf.rest[f] ??= []).push(packet.fsr[f]);
        } else if (buf.elapsed > step.ms * 0.35) {
          buf.pinch.push(packet.fsr[step.key as Finger]); // skip the time spent getting there
        }
        if (now - calUiRef.current > 80) {
          calUiRef.current = now;
          setCalProgress(Math.min(1, buf.elapsed / step.ms));
          setCalRaw(step.key === "open" ? 0 : packet.fsr[step.key as Finger]);
        }

        if (buf.elapsed >= step.ms) {
          if (step.key === "open") {
            for (const f of PINCH_FINGERS) buf.rest_[f] = percentile(buf.rest[f] ?? [], 0.8);
            calStepRef.current += 1;
            Object.assign(buf, { pinch: [], elapsed: 0 });
            setCalMsg(null);
            setCalStep(calStepRef.current);
            setCalProgress(0);
          } else {
            const f = step.key as Finger;
            const rest = buf.rest_[f] ?? 0;
            const max = percentile(buf.pinch, 0.9);
            if (max - rest < 0.12) {
              Object.assign(buf, { pinch: [], elapsed: 0 });
              setCalMsg("Couldn't see a firm pinch. Bring the two fingertips together and hold. Trying that finger again.");
              setCalProgress(0);
            } else {
              calibRef.current = { ...(calibRef.current ?? {}), [f]: { rest, max } };
              calStepRef.current += 1;
              Object.assign(buf, { pinch: [], elapsed: 0 });
              setCalMsg(null);
              setCalStep(calStepRef.current);
              setCalProgress(0);
              if (calStepRef.current >= CAL_STEPS.length) {
                setCalibrated(true);
                activeFingerRef.current = null;
                beginCountdown();
                return;
              }
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    calibRef.current = null;
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [phase, sense, beginCountdown]);

  // 3-2-1 then the round starts
  useEffect(() => {
    if (phase !== "countdown") return;
    const loop = () => {
      sense(performance.now(), false);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    const t = setTimeout(() => {
      if (countdown > 1) {
        setCountdown(countdown - 1);
      } else {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        const now = performance.now();
        const g = createPinch(paramsRef.current, now);
        gameRef.current = g;
        viewRef.current = { bird: 0, trail: [], flash: null, handLost: false, active: null, params: g.params };
        setGame(g);
        setPhase("running");
      }
    }, 1000);
    return () => {
      clearTimeout(t);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [phase, countdown, sense]);

  const finishRound = useCallback(() => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    const g = gameRef.current;
    if (!g) return;
    const stats: PinchStats = { hits: g.hits, leaks: g.leaks, misses: g.misses, score: g.score };
    const prev = historyRef.current[0] ?? null;

    setResult({ stats, params: g.params, prev, total: g.params.pipeCount });
    setHistory((h) => [{ ...stats, params: g.params, at: new Date().toISOString() }, ...h]);
    setOutroDone(false);
    setPhase("outro");
    setTimeout(() => setOutroDone(true), OUTRO_MS);
    void stop({
      ...stats,
      params: g.params,
      pipes: pipeRecords(g),
      calibration: calibRef.current,
      glove: { source: gloveRef.current?.kind ?? "camera-sim" },
    });
  }, [stop]);
  finishRef.current = finishRound;

  useEffect(() => {
    if (phase === "outro" && outroDone && !submitting) setPhase("results");
  }, [phase, outroDone, submitting]);

  // game loop
  useEffect(() => {
    if (phase !== "running") return;
    let lastNow = performance.now();

    const tick = () => {
      const now = performance.now();
      const dt = Math.min(100, now - lastNow);
      lastNow = now;
      const g0 = gameRef.current;
      if (!g0) return;

      const packet = sense(now, true);
      const fresh = packet ?? (packetRef.current && now - packetRef.current.t < STALE_MS ? packetRef.current : null);
      const cal = calibRef.current;
      const f = fresh && cal ? forces(fresh, cal) : ZERO;

      const act = activePipe(g0, now);
      activeFingerRef.current = act?.finger ?? null;
      const raw = act ? f[act.finger] : 0;
      const view = viewRef.current;
      view.bird = steadied(view.bird, raw, dt, g0.params.birdAssist);
      view.active = act?.finger ?? null;
      view.handLost = !fresh;
      view.trail.push({ t: now, v: view.bird });
      while (view.trail.length && now - view.trail[0].t > 1800) view.trail.shift();
      setHandLost(!fresh);

      const g1 = updatePinch(g0, now, view.bird, f);
      for (const p of g1.pipes) {
        if (p.judged && !judgedRef.current.has(p.id)) {
          judgedRef.current.add(p.id);
          if (p.result === "hit") playHit(p.finger);
          else if (p.result === "leak") playLeak(p.finger);
          else playMiss();
          view.flash = {
            text: p.result === "hit" ? "Perfect!" : p.result === "leak" ? "Leaky" : "Missed",
            color: p.result === "hit" ? "#27e0c0" : p.result === "leak" ? "#ffd84a" : "#ff4f8b",
            until: now + 900,
          };
        }
      }

      lastFpsSampleRef.current.count += 1;
      if (now - lastFpsSampleRef.current.t >= 1000) {
        setFps(lastFpsSampleRef.current.count);
        lastFpsSampleRef.current = { t: now, count: 0 };
      }

      gameRef.current = g1;
      setGame(g1);
      drawPinch(canvasRef.current, g1, now, view);

      if (g1.finished) {
        finishRef.current();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [phase, sense]);

  // canvas follows the viewport; the idle scene is redrawn whenever the game isn't ticking
  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const fit = () => {
      canvas.width = stage.clientWidth;
      canvas.height = stage.clientHeight;
      if (phase !== "running") drawPinch(canvas, null, performance.now(), { ...viewRef.current, params: paramsRef.current });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [phase]);

  useEffect(() => () => releaseCamera(), [releaseCamera]);

  const quit = () => {
    framesRef.current = [];
    releaseCamera();
  };

  const nextAttempt = () => {
    setError(null);
    setSaveNote(null);
    setResult(null);
    setAnalysis(null);
    setAnalysisError(null);
    setGame(null);
    setPhase("intro");
  };

  const total = game?.params.pipeCount ?? params.pipeCount;
  const judged = game ? game.hits + game.leaks + game.misses : 0;
  const label = mode === "reference" ? "Recording a reference" : mode === "practice" ? "Practice run" : "Today's round";
  const calStepDef = CAL_STEPS[Math.min(calStep, CAL_STEPS.length - 1)];

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
          <Progress.Root value={judged} max={total || 1} style={{ flex: "1 1 240px" }}>
            <Progress.Track className="progress-track">
              <Progress.Range className="progress-range" />
            </Progress.Track>
          </Progress.Root>
          <div className="pill"><span>Score</span><b>{game?.score ?? 0}</b></div>
          <div className="pill"><span>Perfect</span><b style={{ color: "var(--mint)" }}>{game?.hits ?? 0}</b></div>
          <div className="pill"><span>Leaky</span><b style={{ color: "var(--sun)" }}>{game?.leaks ?? 0}</b></div>
          <div className="pill"><span>Missed</span><b style={{ color: "var(--coral)" }}>{game?.misses ?? 0}</b></div>
          <div className="pill"><span>FPS</span><b>{fps}</b></div>
          {phase === "running" && (
            <button onClick={finishRound} className="btn btn-danger">Finish round</button>
          )}
        </div>
      )}

      {phase === "running" && handLost && (
        <div className="hand-lost" role="status">Show your hand to the camera</div>
      )}

      <video ref={videoRef} autoPlay muted playsInline style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />

      {phase === "calibrate" && (
        <div className="cal-wrap">
          <div className="cal-panel card">
            <p className="eyebrow" style={{ color: "var(--brand)" }}>
              Quick calibration · step {Math.min(calStep + 1, CAL_STEPS.length)} of {CAL_STEPS.length}
            </p>
            <p className="display" style={{ fontSize: "1.7rem", margin: "0.2rem 0" }}>{calStepDef.title}</p>
            <p style={{ color: "var(--foreground-muted)" }}>{calStepDef.hint}</p>

            <div className="cal-steps" aria-hidden>
              {CAL_STEPS.map((s, i) => (
                <i key={s.key} data-state={i < calStep ? "done" : i === calStep ? "now" : "todo"} />
              ))}
            </div>

            <Progress.Root value={calProgress} max={1}>
              <Progress.Track className="progress-track">
                <Progress.Range className="progress-range" />
              </Progress.Track>
            </Progress.Root>

            {calStepDef.key !== "open" && (
              <div className="cal-live" aria-hidden>
                <span>Pinch now</span>
                <div className="cal-bar"><i style={{ width: `${Math.round(calRaw * 100)}%`, background: FINGER_COLOR[calStepDef.key as Finger] }} /></div>
              </div>
            )}
            {handLost && <p className="form-error" style={{ marginTop: "0.6rem" }}>Show your hand to the camera. The timer waits for you.</p>}
            {calMsg && <p className="form-error" style={{ marginTop: "0.6rem" }}>{calMsg}</p>}
            <p className="setting-hint" style={{ marginTop: "0.8rem" }}>
              This sets what &ldquo;gentle&rdquo; and &ldquo;firm&rdquo; mean for <b>your</b> hand, so the game fits your strength.
            </p>
          </div>
        </div>
      )}

      {phase === "countdown" && (
        <div style={{ position: "absolute", inset: 0, zIndex: 4, display: "grid", placeItems: "center", pointerEvents: "none" }}>
          <div key={countdown} className="countdown-num">{countdown}</div>
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
          calibrated={calibrated}
          onStart={() => start(false)}
          onRecalibrate={() => start(true)}
        />
      )}

      {phase === "loading" && (
        <div className="game-screen">
          <Spinner size={48} />
          <p className="display" style={{ fontSize: "1.6rem" }}>Warming up the camera and hand tracker...</p>
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

const SETTING_META: Record<PinchNumericKey, { icon: LucideIcon; color: string; hint: string }> = {
  forceLow: { icon: Feather, color: "var(--sky-deep)", hint: "Softest pinch a gate asks for" },
  forceHigh: { icon: Dumbbell, color: "var(--coral-deep)", hint: "Firmest pinch a gate asks for" },
  bandWidth: { icon: Ruler, color: "var(--brand)", hint: "How much room you have to be off" },
  holdMs: { icon: Timer, color: "var(--mint-deep)", hint: "How long to keep the pinch steady" },
  restMs: { icon: Hourglass, color: "var(--sun-deep)", hint: "Time to relax between gates" },
  scrollMs: { icon: Wind, color: "var(--sky-deep)", hint: "How early each gate shows up" },
  dynamicMix: { icon: Waves, color: "var(--lilac-deep, #8a5bd6)", hint: "Gates that move up or down" },
  birdAssist: { icon: Anchor, color: "var(--mint-deep)", hint: "Smooths out shaking for you" },
  isolationTolerance: { icon: Fingerprint, color: "var(--lilac-deep, #8a5bd6)", hint: "Pressure allowed in other fingers" },
  pipeCount: { icon: ListOrdered, color: "var(--coral-deep)", hint: "Gates in this round" },
};

const fmtValue = (key: string, v: unknown): string => {
  if (v === null || v === undefined) return "none";
  if (typeof v === "string") return v.charAt(0).toUpperCase() + v.slice(1);
  const m = PINCH_LABELS[key as PinchNumericKey];
  if (!m) return String(v);
  return m.unit === "%" ? `${Math.round(Number(v) * 100)}%` : m.unit === "ms" ? `${Math.round(Number(v))} ms` : String(Math.round(Number(v)));
};

function IntroScreen({
  mode, label, backHref, history, historyLoading, params, why, prescribed, calibrated, onStart, onRecalibrate,
}: {
  mode: PinchMode;
  label: string;
  backHref: string;
  history: PastRound[];
  historyLoading: boolean;
  params: PinchParams;
  why: string | null;
  prescribed: boolean;
  calibrated: boolean;
  onStart: () => void;
  onRecalibrate: () => void;
}) {
  const last = history[0];
  const best = history.reduce((m, h) => Math.max(m, h.score), 0);
  const recent = history.slice(0, 8).reverse();
  const rule =
    mode === "reference"
      ? "Play it the way patients should. This round is saved as the idealized reference."
      : mode === "practice"
        ? "Practice run. Nothing you do here is saved."
        : "Pinch your thumb to the lit finger. Press harder to fly higher, and keep the bird inside the gate until it ends.";

  return (
    <div className="game-screen">
      <div className="falling-notes" aria-hidden>
        {PINCH_FINGERS.map((f, i) => (
          <i key={f} style={{ ["--x" as string]: `${14 + i * 24}%`, ["--c" as string]: FINGER_COLOR[f], ["--d" as string]: `${i * 0.9}s` }} />
        ))}
      </div>

      <a href={backHref} className="eyebrow muted-on-dark" style={{ position: "absolute", top: "1.25rem", left: "1.5rem", zIndex: 2 }}>
        <ArrowLeft size={14} strokeWidth={3} style={{ verticalAlign: "-2px" }} /> Exit game
      </a>

      <p className="eyebrow rise" style={{ color: "var(--sun)" }}>{label}</p>
      <h1 className="game-title display">Pinch Flight</h1>
      <p className="muted-on-dark rise" style={{ ["--i" as string]: 3, maxWidth: 560, textAlign: "center", fontSize: "1.1rem" }}>{rule}</p>

      <Carousel.Root className="result-carousel intro-carousel rise" slideCount={2} spacing="16px" style={{ ["--i" as string]: 4 }}>
        <Carousel.ItemGroup className="result-slides">
        <Carousel.Item index={0}>
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
                <Mini label="Last accuracy" value={pct(pinchAccuracy(last))} />
                <Mini label="Last score" value={String(last.score)} />
                <Mini label="Best score" value={String(best)} />
                <Mini label="Attempts" value={String(history.length)} />
              </div>
              <div className="bar-strip" aria-label="Accuracy of recent attempts">
                {recent.map((h, i) => (
                  <i key={i} style={{ ["--h" as string]: `${Math.max(6, pinchAccuracy(h) * 100)}%` }} title={pct(pinchAccuracy(h))} />
                ))}
              </div>
              <p style={{ fontSize: "0.78rem", color: "var(--foreground-muted)", marginTop: "0.35rem" }}>Accuracy per attempt, latest in orange.</p>
            </>
          ) : (
            <p style={{ color: "var(--foreground-muted)" }}>
              {mode === "patient" ? "No attempts yet. This one sets your starting point." : "Nothing yet in this session."}
            </p>
          )}
          <div className="cal-status">
            <Fingerprint size={18} strokeWidth={2.6} />
            <span>{calibrated ? "Your pinch strength is calibrated for this session." : "A 15-second calibration comes first."}</span>
            {calibrated && (
              <button className="btn btn-outline" style={{ marginLeft: "auto", padding: "0.3rem 0.8rem", fontSize: "0.85rem" }} onClick={onRecalibrate}>
                Recalibrate
              </button>
            )}
          </div>
        </div>
        </Carousel.Item>

        <Carousel.Item index={1}>
        <div className="card">
          <p className="field-label" style={{ marginBottom: "0.6rem" }}>Game settings this round</p>
          <div className="setting-grid">
            {(Object.keys(PINCH_LABELS) as PinchNumericKey[]).map((k) => {
              const Icon = SETTING_META[k].icon;
              return (
                <div key={k} className="setting-tile" style={{ ["--c" as string]: SETTING_META[k].color }}>
                  <span className="setting-icon"><Icon size={22} strokeWidth={2.6} /></span>
                  <div>
                    <p className="setting-label">{PINCH_LABELS[k].label}</p>
                    <Meter scale={PINCH_SCALE[k]} value={params[k]} />
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
        </Carousel.Item>
        </Carousel.ItemGroup>

        <Carousel.Control className="result-nav">
          <Carousel.PrevTrigger className="icon-btn result-arrow" aria-label="Previous">
            <ChevronLeft size={22} strokeWidth={3} />
          </Carousel.PrevTrigger>
          <Carousel.IndicatorGroup className="result-tabs">
            {["Your history", "This round's settings"].map((l, n) => (
              <Carousel.Indicator key={l} index={n} className="result-tab">{l}</Carousel.Indicator>
            ))}
          </Carousel.IndicatorGroup>
          <Carousel.NextTrigger className="icon-btn result-arrow" aria-label="Next">
            <ChevronRight size={22} strokeWidth={3} />
          </Carousel.NextTrigger>
        </Carousel.Control>
      </Carousel.Root>

      {!prescribed && (
        <p className="form-error" style={{ maxWidth: 480, textAlign: "center" }}>
          This game isn&apos;t prescribed to you yet, so rounds can&apos;t be saved. Ask your physiatrist to add it.
        </p>
      )}
      <button onClick={onStart} disabled={historyLoading || !prescribed} className="btn btn-go btn-lg rise" style={{ ["--i" as string]: 6, fontSize: "1.4rem" }}>
        <BusyLabel busy={historyLoading} busyText="Loading...">
          <Play size={22} fill="currentColor" /> Start
        </BusyLabel>
      </button>
    </div>
  );
}

const METRIC_SHORT: Record<string, string> = {
  force_error: "Force control", latency_ms: "Reach time", wobble: "Steadiness", overshoot: "Overshoot", leak: "Isolation", clean_rate: "Clean",
};

function ResultsScreen({
  mode, result, analysis, analysisError, saveNote, error, backHref, onNext,
}: {
  mode: PinchMode;
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
  const verdict = ["Keep going. Every rep counts!", "Nice start!", "Great flying!", "Flawless control!"][stars];
  const acc = Math.round(pinchAccuracy(stats) * 100);
  const prevAcc = prev ? Math.round(pinchAccuracy(prev) * 100) : 0;
  const adapt = analysis?.adaptation ?? null;
  const prevA = analysis?.previous ?? null;
  const judged = stats.hits + stats.leaks + stats.misses;
  const outcomes: { label: string; value: number; before: number | null; better: "up" | "down"; color: string; soft: string; icon: LucideIcon }[] = [
    { label: "Perfect", value: stats.hits, before: prev ? prev.hits : null, better: "up", color: "var(--mint-deep)", soft: "var(--mint-soft)", icon: CircleCheck },
    { label: "Leaky", value: stats.leaks, before: prev ? prev.leaks : null, better: "down", color: "var(--sun-deep)", soft: "var(--sun-soft)", icon: Droplets },
    { label: "Missed", value: stats.misses, before: prev ? prev.misses : null, better: "down", color: "var(--coral-deep)", soft: "var(--coral-soft)", icon: CircleX },
  ];
  const changeByKey = new Map((adapt?.changes ?? []).map((c) => [c.key, c]));
  const nextParams = adapt ? normalizePinchParams(adapt.next_params) : result.params;
  const tone = !adapt || adapt.verdict === "hold" ? "same" : adapt.verdict;
  const series = analysis?.trend.accuracy_series ?? [];
  const handDriver = analysis?.drivers.find((d) => d.metric === "tremor" || d.metric === "jerk") ?? null;

  return (
    <div className="game-screen">
      <p className="eyebrow rise" style={{ color: "var(--sun)" }}>
        {mode === "reference" ? "Reference recorded" : mode === "practice" ? "Practice complete" : "Round complete"}
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: "1.5rem", flexWrap: "wrap", justifyContent: "center" }}>
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
                  <p className="setting-hint" style={{ maxWidth: 190, textAlign: "right" }}>First attempt: this round is your baseline.</p>
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
                        <p className="setting-hint">{judged ? pct(o.value / judged) : "-"} of gates</p>
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
                      <p className="setting-value" style={{ fontSize: "3rem" }}>{Math.round(analysis.deviation_score)}<small>/100</small></p>
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
                      const worst = Object.entries(f.values ?? {})
                        .filter(([k]) => k !== "clean_rate")
                        .map(([k]) => k)
                        .find((k) => analysis.drivers.some((d) => d.finger === f.finger && d.metric === k));
                      return (
                        <div key={f.finger} className="finger-row">
                          <span className="finger-dot" style={{ background: FINGER_COLOR[f.finger as Finger] }} />
                          <span style={{ fontWeight: 800, textTransform: "capitalize", width: 64 }}>{f.finger}</span>
                          <span className="finger-track" aria-hidden>
                            <i style={{ width: `${Math.max(4, 100 - Math.min(100, (f.badness / 3) * 100))}%`, background: st.color }} />
                          </span>
                          <span className="delta" data-tone={st.tone}>{worst ? METRIC_SHORT[worst] ?? st.text : st.text}</span>
                        </div>
                      );
                    })}
                  </div>

                  <p className="setting-label" style={{ margin: "0.9rem 0 0.35rem" }}>Hand steadiness</p>
                  <div className="driver-row">
                    <span className="driver-share">{handDriver ? "!" : <CircleCheck size={16} strokeWidth={3} />}</span>
                    <span>{handDriver ? handDriver.detail : "Your palm stayed as steady as the reference."}</span>
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
                    <p className="setting-hint" style={{ marginTop: "0.8rem" }}>Nothing stands out: your control matches the reference.</p>
                  )}
                </>
              ) : (
                <p className="setting-hint">
                  {analysisError
                    ? `Couldn't compare with the reference: ${analysisError}`
                    : "No glove data was captured this round, so there's nothing to compare."}
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
                <p className="setting-hint" style={{ margin: "0.5rem 0 0" }}>{adapt.rationale} Confidence {Math.round(adapt.confidence * 100)}%.</p>
              )}
              <div className="setting-grid" style={{ marginTop: "0.8rem" }}>
                {(Object.keys(PINCH_LABELS) as PinchNumericKey[]).map((k) => {
                  const c = changeByKey.get(k);
                  const Icon = SETTING_META[k].icon;
                  return (
                    <div key={k} className="setting-tile" data-changed={!!c} style={{ ["--c" as string]: SETTING_META[k].color }}>
                      <span className="setting-icon"><Icon size={22} strokeWidth={2.6} /></span>
                      <div>
                        <p className="setting-label">{PINCH_LABELS[k].label}</p>
                        <Meter scale={PINCH_SCALE[k]} value={nextParams[k]} from={c ? Number(c.from_value) : undefined} />
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
                            <span className="setting-from">{fmtValue("focusFinger", changeByKey.get("focusFinger")!.from_value)}</span>
                            <ArrowRight size={18} strokeWidth={3} style={{ margin: "0 0.25rem", verticalAlign: "-1px" }} />
                          </>
                        )}
                        {fmtValue("focusFinger", nextParams.focusFinger)}
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
            {["This round", "Vs. the ideal", "Next attempt"].map((l, n) => (
              <Carousel.Indicator key={l} index={n} className="result-tab">{l}</Carousel.Indicator>
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


/* ------------------------------------------------------ gate hand sprites */

const spriteCache = new Map<Finger, HTMLCanvasElement>();

/** A still, palm-toward-viewer hand (thumb on the left) with the finger to pinch coloured. */
function handSprite(target: Finger): HTMLCanvasElement {
  const hit = spriteCache.get(target);
  if (hit) return hit;
  const k = 2; // drawn at 2x for crispness
  const c = document.createElement("canvas");
  c.width = 80 * k;
  c.height = 96 * k;
  const ctx = c.getContext("2d")!;
  ctx.scale(k, k);
  const SKIN = "#e9c9ad";
  const EDGE = "rgba(5,35,44,0.45)";
  const limb = (x0: number, y0: number, x1: number, y1: number, w: number, fill: string, stroke: string) => {
    ctx.lineCap = "round";
    ctx.strokeStyle = stroke;
    ctx.lineWidth = w + 4;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.strokeStyle = fill;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  // palm
  ctx.fillStyle = SKIN;
  ctx.strokeStyle = EDGE;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(22, 52, 44, 40, 14);
  ctx.fill();
  ctx.stroke();
  const fingers: [Finger, number, number][] = [["index", 28, 30], ["middle", 39, 22], ["ring", 50, 27], ["pinky", 60, 38]];
  for (const [f, x, topY] of fingers) {
    const on = f === target;
    limb(x, 60, x, topY, 9, on ? FINGER_COLOR[f] : SKIN, on ? "#ffffff" : EDGE);
  }
  // thumb, reaching toward the target
  limb(26, 80, 9, 56, 11, SKIN, EDGE);
  // redraw the target finger over the palm edge so its colour is not clipped
  const tf = fingers.find(([f]) => f === target);
  if (tf) limb(tf[1], 60, tf[1], tf[2], 9, FINGER_COLOR[target], "#ffffff");
  spriteCache.set(target, c);
  return c;
}

/* ----------------------------------------------------------------- canvas */

interface View {
  bird: number;
  trail: { t: number; v: number }[];
  flash: { text: string; color: string; until: number } | null;
  handLost: boolean;
  active: Finger | null;
  params: PinchParams;
}

const RESULT_TINT = { hit: "#27e0c0", leak: "#ffd84a", miss: "#ff4f8b" } as const;

function drawPinch(canvas: HTMLCanvasElement | null, g: PinchState | null, nowMs: number, view: View) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;

  const top = 128;
  const bottom = H - 64;
  const plotH = Math.max(80, bottom - top);
  const yOf = (f: number) => bottom - f * plotH;
  const birdX = Math.max(150, W * 0.2);
  const scrollMs = (g?.params ?? view.params).scrollMs;
  const pxPerMs = (W - birdX - 40) / scrollMs;

  ctx.fillStyle = "#05232c";
  ctx.fillRect(0, 0, W, H);

  // soft clouds drifting with the scroll
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  for (let i = 0; i < 6; i++) {
    const x = (((i * 337 - nowMs * 0.02 * (1 + (i % 3) * 0.4)) % (W + 240)) + W + 240) % (W + 240) - 120;
    const y = top + ((i * 97) % Math.max(1, plotH));
    ctx.beginPath();
    ctx.ellipse(x, y, 70, 22, 0, 0, Math.PI * 2);
    ctx.ellipse(x + 40, y - 10, 46, 20, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // force scale
  ctx.font = "600 12px Fredoka, system-ui";
  ctx.textAlign = "left";
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    ctx.strokeStyle = f === 0 ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.08)";
    ctx.lineWidth = f === 0 ? 3 : 1;
    ctx.beginPath();
    ctx.moveTo(48, yOf(f));
    ctx.lineTo(W, yOf(f));
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillText(`${Math.round(f * 100)}%`, 10, yOf(f) + 4);
  }
  ctx.save();
  ctx.translate(30, (top + bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fillText("pinch force", 0, 0);
  ctx.restore();

  // gates
  if (g) {
    for (const p of g.pipes) {
      const x0 = birdX + (p.startMs - nowMs) * pxPerMs;
      const x1 = birdX + (p.endMs - nowMs) * pxPerMs;
      if (x1 < 40 || x0 > W + 20) continue;
      const half = p.band / 2;
      const tint = p.result ? RESULT_TINT[p.result] : FINGER_COLOR[p.finger];
      const stops = p.kind === "step" ? [0, 0.4999, 0.5, 1] : [0, 1];
      const pts = stops.map((u) => ({ x: x0 + (x1 - x0) * u, c: centreAt(p, u) }));
      const wallTop = top - 22;
      const wallBottom = bottom + 22;

      const wall = (upper: boolean) => {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, upper ? wallTop : wallBottom);
        for (const q of pts) ctx.lineTo(q.x, yOf(upper ? q.c + half : q.c - half));
        ctx.lineTo(pts[pts.length - 1].x, upper ? wallTop : wallBottom);
        ctx.closePath();
      };
      ctx.globalAlpha = p.judged ? 0.55 : 0.9;
      for (const upper of [true, false]) {
        wall(upper);
        ctx.fillStyle = tint;
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.7)";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // the band itself, softly lit
      ctx.beginPath();
      ctx.moveTo(pts[0].x, yOf(pts[0].c + half));
      for (const q of pts) ctx.lineTo(q.x, yOf(q.c + half));
      for (const q of [...pts].reverse()) ctx.lineTo(q.x, yOf(q.c - half));
      ctx.closePath();
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.fill();

      // a still hand on the gate with the finger to pinch coloured, on whichever wall has the room
      {
        const sw = 56, sh = 67;
        const visL = Math.max(x0, 20), visR = Math.min(x1, W - 20);
        if (visR - visL > sw * 0.8) {
          const cx = (visL + visR) / 2;
          const u = Math.min(1, Math.max(0, (cx - x0) / (x1 - x0)));
          const cc = centreAt(p, u);
          const upperRoom = yOf(cc + half) - (top - 22);
          const lowerRoom = bottom + 22 - yOf(cc - half);
          const useUpper = upperRoom >= lowerRoom;
          if (Math.max(upperRoom, lowerRoom) >= sh + 14) {
            const y = useUpper ? yOf(cc + half) - sh - 10 : yOf(cc - half) + 10;
            ctx.globalAlpha = p.judged ? 0.5 : 1;
            ctx.fillStyle = "rgba(5,35,44,0.55)";
            ctx.beginPath();
            ctx.roundRect(cx - sw / 2 - 5, y - 4, sw + 10, sh + 8, 14);
            ctx.fill();
            ctx.drawImage(handSprite(p.finger), cx - sw / 2, y, sw, sh);
            ctx.globalAlpha = 1;
          }
        }
      }

      // finger tag above the gate
      const tagX = Math.min(Math.max((Math.max(x0, 60) + Math.min(x1, W - 20)) / 2, 70), W - 70);
      const label = p.finger.toUpperCase();
      ctx.font = "700 14px Fredoka, system-ui";
      const tw = ctx.measureText(label).width + 22;
      ctx.fillStyle = FINGER_COLOR[p.finger];
      ctx.beginPath();
      ctx.roundRect(tagX - tw / 2, top - 52, tw, 26, 13);
      ctx.fill();
      ctx.fillStyle = "#05232c";
      ctx.textAlign = "center";
      ctx.fillText(label, tagX, top - 34);
    }
  }

  // trail
  if (view.trail.length > 1) {
    ctx.lineJoin = "round";
    for (let i = 1; i < view.trail.length; i++) {
      const a = view.trail[i - 1];
      const b = view.trail[i];
      ctx.strokeStyle = `rgba(255,216,74,${0.05 + 0.4 * (i / view.trail.length)})`;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(birdX - (nowMs - a.t) * pxPerMs, yOf(a.v));
      ctx.lineTo(birdX - (nowMs - b.t) * pxPerMs, yOf(b.v));
      ctx.stroke();
    }
  }

  // bird
  const by = yOf(view.bird);
  const act = g ? activePipe(g, nowMs) : null;
  const gate = act && g ? inGate(act, nowMs) : false;
  let inBand = false;
  if (act && gate) {
    const u = (nowMs - act.startMs) / (act.endMs - act.startMs);
    inBand = Math.abs(view.bird - centreAt(act, u)) <= act.band / 2;
  }
  const ring = !gate ? "#ffffff" : inBand ? "#27e0c0" : "#ff7a3d";
  ctx.globalAlpha = view.handLost ? 0.35 : 1;
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.beginPath();
  ctx.ellipse(birdX, by + 30, 18, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffd84a";
  ctx.strokeStyle = ring;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(birdX, by, 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  const flap = Math.sin(nowMs / 90) * 7;
  ctx.fillStyle = "#ffb627";
  ctx.beginPath();
  ctx.ellipse(birdX - 8, by + 4, 12, 7 + flap * 0.4, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ff7a3d";
  ctx.beginPath();
  ctx.moveTo(birdX + 22, by - 3);
  ctx.lineTo(birdX + 36, by + 3);
  ctx.lineTo(birdX + 22, by + 9);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#05232c";
  ctx.beginPath();
  ctx.arc(birdX + 9, by - 7, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.font = "700 13px Fredoka, system-ui";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText(`${Math.round(view.bird * 100)}%`, birdX, by - 34);

  // what to press right now
  if (view.active) {
    ctx.textAlign = "left";
    ctx.font = "700 20px Fredoka, system-ui";
    ctx.fillStyle = FINGER_COLOR[view.active];
    ctx.fillText(`Pinch: thumb + ${view.active}`, 24, top - 38);
  }

  if (view.flash && nowMs < view.flash.until) {
    const k = 1 - (view.flash.until - nowMs) / 900;
    ctx.globalAlpha = 1 - k;
    ctx.font = "800 30px Fredoka, system-ui";
    ctx.textAlign = "center";
    ctx.fillStyle = view.flash.color;
    ctx.fillText(view.flash.text, birdX + 90, by - 20 - k * 40);
    ctx.globalAlpha = 1;
  }
}
