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
 * POST /attempts/batch call when the session stops -- so patient attempts
 * are directly comparable to the idealized reference, no server-side
 * reprocessing step needed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import HandTwin3D, { HandTwin3DHandle } from "@/components/HandTwin3D";
import { supabase } from "@/lib/supabase";
import { submitAttemptBatch } from "@/lib/engine";
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
  FINGER_NOTE,
  GameState,
  createGame,
  startRound,
  maybeSpawn,
  updateGame,
  noteProgress,
  currentPromptFinger,
} from "@/lib/pianoGame";

const EXERCISE_ID = "piano_isolated_press";

const CANVAS_W = 900;
const CANVAS_H = 700;
const TARGET_Y = CANVAS_H - 120;
const LANE_MARGIN = 40;
const LANE_W = (CANVAS_W - 2 * LANE_MARGIN) / ACTIVE_FINGERS.length;

const FINGER_COLOR: Record<Finger, string> = {
  thumb: "rgb(255,170,80)",
  index: "rgb(120,200,255)",
  middle: "rgb(130,230,160)",
  ring: "rgb(200,150,255)",
  pinky: "rgb(160,160,255)",
};

type Status = "idle" | "loading" | "running" | "finished" | "error";

export default function PianoGamePage() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [game, setGame] = useState<GameState>(createGame());
  const [fps, setFps] = useState(0);

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
  const [submitting, setSubmitting] = useState(false);
  const soundedNoteIdsRef = useRef<Set<number>>(new Set());

  gameRef.current = game;

  const stop = useCallback(async () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    landmarkerRef.current?.close();
    landmarkerRef.current = null;

    const frames = framesRef.current;
    const accessToken = accessTokenRef.current;
    framesRef.current = [];
    accessTokenRef.current = null;

    if (frames.length > 0 && accessToken) {
      setSubmitting(true);
      try {
        await submitAttemptBatch(accessToken, EXERCISE_ID, frames, {
          score: gameRef.current.score,
          hits: gameRef.current.hits,
          leaks: gameRef.current.leaks,
          misses: gameRef.current.misses,
        });
      } catch (err) {
        console.error("failed to submit attempt", err);
      } finally {
        setSubmitting(false);
      }
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setStatus("loading");
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

      setGame((g) => startRound(g, performance.now()));
      setStatus("running");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start.");
      setStatus("error");
      stop();
    }
  }, [stop]);

  const handleStop = useCallback(async () => {
    setStatus("finished");
    await stop();
  }, [stop]);

  const handlePlayAgain = useCallback(() => {
    setGame(createGame());
    setStatus("idle");
  }, []);

  useEffect(() => {
    if (status !== "running") return;

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
          const highlight = currentPromptFinger(gameRef.current);
          twinHandleRef.current?.update(curlsRef.current, highlight);

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
          if (note.result === "hit") playHit(note.finger);
          else if (note.result === "leak") playLeak(note.finger);
          else if (note.result === "miss") playMiss();
        }
      }

      gameRef.current = nextGame;
      setGame(nextGame);
      draw(canvasRef.current, nextGame, nowMs, curlsRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [status]);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  const notesTotal = game.params.sequenceLength;
  const notesDone = Math.min(game.spawned, notesTotal);

  return (
    <main className="page" style={{ maxWidth: 1180 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "1rem",
          marginBottom: "1.75rem",
        }}
      >
        <div>
          <a
            href="/patient"
            style={{
              fontSize: "0.82rem",
              fontWeight: 600,
              color: "var(--foreground-muted)",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.3rem",
              marginBottom: "0.5rem",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M19 12H5M11 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back to games
          </a>
          <h1 style={{ fontSize: "1.6rem", fontWeight: 700 }}>Piano Press</h1>
          <p style={{ color: "var(--foreground-muted)", fontSize: "0.88rem", marginTop: "0.25rem", maxWidth: 520 }}>
            Curl each finger to its note as it reaches the line below. Only the prompted finger should move.
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.6rem" }}>
          {status === "idle" && (
            <button onClick={start} className="btn btn-primary">
              Start session
            </button>
          )}
          {status === "running" && (
            <button onClick={handleStop} className="btn btn-danger">
              Stop
            </button>
          )}
          {status === "finished" && !submitting && (
            <button onClick={handlePlayAgain} className="btn btn-primary">
              Play again
            </button>
          )}
        </div>
      </div>

      {error && (
        <div
          className="card"
          style={{
            padding: "0.85rem 1.1rem",
            marginBottom: "1.25rem",
            borderColor: "var(--danger)",
            background: "#fdf1ef",
            color: "var(--danger)",
            fontSize: "0.88rem",
          }}
        >
          {error}
        </div>
      )}

      {status === "loading" && (
        <div
          className="card"
          style={{
            padding: "0.85rem 1.1rem",
            marginBottom: "1.25rem",
            fontSize: "0.88rem",
            color: "var(--foreground-muted)",
          }}
        >
          Loading MediaPipe + camera...
        </div>
      )}

      {submitting && (
        <div
          className="card"
          style={{
            padding: "0.85rem 1.1rem",
            marginBottom: "1.25rem",
            fontSize: "0.88rem",
            color: "var(--foreground-muted)",
          }}
        >
          Submitting attempt to engine...
        </div>
      )}

      {status === "finished" && !submitting && (
        <div
          className="card"
          style={{
            padding: "1.5rem",
            marginBottom: "1.25rem",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
            gap: "1.25rem",
          }}
        >
          <SummaryStat label="Score" value={game.score} color="var(--primary)" />
          <SummaryStat label="Hits" value={game.hits} color="var(--success)" />
          <SummaryStat label="Leaks" value={game.leaks} color="var(--warning)" />
          <SummaryStat label="Misses" value={game.misses} color="var(--danger)" />
          <SummaryStat label="Notes" value={`${notesDone}/${notesTotal}`} color="var(--foreground)" />
        </div>
      )}

      <div style={{ display: "flex", gap: "1.25rem", alignItems: "flex-start", flexWrap: "wrap" }}>
        <div
          className="card"
          style={{ padding: "0.75rem", flex: "1 1 600px", minWidth: 0, position: "relative" }}
        >
          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            style={{
              width: "100%",
              height: "auto",
              display: "block",
              borderRadius: "var(--radius-md)",
              background: "#111",
            }}
          />
          {status === "idle" && (
            <div
              style={{
                position: "absolute",
                inset: "0.75rem",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "0.75rem",
                borderRadius: "var(--radius-md)",
                color: "#9aa6b2",
                fontSize: "0.9rem",
                pointerEvents: "none",
              }}
            >
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
                <path
                  d="M8 5v14l11-7z"
                  fill="#9aa6b2"
                />
              </svg>
              Press start to begin your session
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "1rem", width: 260 }}>
          <div className="card" style={{ padding: "1rem" }}>
            <p
              style={{
                fontSize: "0.75rem",
                fontWeight: 700,
                color: "var(--foreground-muted)",
                letterSpacing: "0.02em",
                marginBottom: "0.75rem",
              }}
            >
              HAND TWIN
            </p>
            <div
              style={{
                borderRadius: "var(--radius-sm)",
                overflow: "hidden",
                background: "#ffffff",
                border: "1px solid var(--border)",
              }}
            >
              <HandTwin3D width={236} height={236} handleRef={twinHandleRef} />
            </div>
          </div>

          {status === "running" && (
            <div className="card" style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              <StatRow label="Score" value={game.score} />
              <StatRow label="Hits" value={game.hits} color="var(--success)" />
              <StatRow label="Leaks" value={game.leaks} color="var(--warning)" />
              <StatRow label="Misses" value={game.misses} color="var(--danger)" />
              <StatRow label="Notes" value={`${notesDone}/${notesTotal}`} />
              <StatRow label="FPS" value={fps} />
            </div>
          )}
        </div>

        {/* video element stays mounted (MediaPipe reads frames from it) but hidden -- the 3D twin is the visible feedback now */}
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        />
      </div>
    </main>
  );
}

function SummaryStat({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div>
      <p style={{ fontSize: "1.5rem", fontWeight: 700, color }}>{value}</p>
      <p style={{ fontSize: "0.78rem", color: "var(--foreground-muted)", marginTop: "0.15rem" }}>{label}</p>
    </div>
  );
}

function StatRow({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
      <span style={{ fontSize: "0.82rem", color: "var(--foreground-muted)" }}>{label}</span>
      <span style={{ fontSize: "0.95rem", fontWeight: 700, color: color ?? "var(--foreground)" }}>{value}</span>
    </div>
  );
}

function draw(
  canvas: HTMLCanvasElement | null,
  game: GameState,
  nowMs: number,
  curls: Partial<Record<Finger, number>>
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  if (game.waitingToStart) {
    ctx.strokeStyle = "#0c8";
    ctx.strokeRect(CANVAS_W / 2 - 150, CANVAS_H / 2 - 40, 300, 80);
    ctx.fillStyle = "#fff";
    ctx.font = "18px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Starting...", CANVAS_W / 2, CANVAS_H / 2 + 6);
    return;
  }

  ACTIVE_FINGERS.forEach((finger, i) => {
    const x0 = LANE_MARGIN + LANE_W * i;
    ctx.strokeStyle = "#333";
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.lineTo(x0, CANVAS_H);
    ctx.stroke();

    ctx.fillStyle = FINGER_COLOR[finger];
    ctx.font = "14px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(`${finger.slice(0, 3).toUpperCase()} ${FINGER_NOTE[finger]}`, x0 + 10, CANVAS_H - 20);

    const curl = curls[finger] ?? 0;
    const barH = curl * 80;
    ctx.fillStyle = FINGER_COLOR[finger];
    ctx.fillRect(x0 + LANE_W - 22, CANVAS_H - 40 - barH, 14, barH);
    ctx.strokeStyle = "#555";
    ctx.strokeRect(x0 + LANE_W - 22, CANVAS_H - 120, 14, 80);
  });

  ctx.strokeStyle = "#0c8";
  ctx.beginPath();
  ctx.moveTo(LANE_MARGIN, TARGET_Y);
  ctx.lineTo(CANVAS_W - LANE_MARGIN, TARGET_Y);
  ctx.stroke();

  for (const note of game.notes) {
    const i = ACTIVE_FINGERS.indexOf(note.finger);
    const x = LANE_MARGIN + LANE_W * i + LANE_W / 2;
    const progress = noteProgress(note, nowMs);
    const y = progress * TARGET_Y;

    let color = FINGER_COLOR[note.finger];
    if (note.result === "hit") color = "#2ecc71";
    else if (note.result === "leak") color = "#f1c40f";
    else if (note.result === "miss") color = "#e74c3c";

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 16, 0, Math.PI * 2);
    ctx.fill();
  }
}
