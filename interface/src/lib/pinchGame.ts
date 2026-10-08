/**
 * Pinch Flight game logic.
 *
 * A bird flies at a fixed spot while gates scroll toward it. The bird's height is the force the patient
 * applies between the thumb and ONE finger (the finger the next gate asks for), as a fraction of that
 * patient's own range (see glove.ts: calibration). Each gate holds a target band of force; pass it by
 * keeping the bird inside the band for the gate's whole length. Gates can be steady, step to another
 * level halfway, or ramp smoothly, and each one asks for a different finger.
 *
 * The engine decides the settings (engine/adapt/pinch.py) and judges the features
 * (engine/features/pinch.py); this file only plays the round and keeps the record the engine reads
 * (`meta.pipes`).
 */

import type { Finger } from "@/lib/handFeatures";
import type { Scale } from "@/components/games/SettingMeter";

export const PINCH_FINGERS: Finger[] = ["index", "middle", "ring", "pinky"];
const COUPLED: Partial<Record<Finger, Finger>> = { ring: "pinky", pinky: "ring" };

export interface PinchParams {
  /** centre of the lightest gates, fraction of the patient's range */
  forceLow: number;
  /** centre of the hardest gates */
  forceHigh: number;
  /** full height of the target band */
  bandWidth: number;
  holdMs: number;
  restMs: number;
  /** how long a gate takes from appearing to reaching the bird */
  scrollMs: number;
  /** share of gates that step or ramp */
  dynamicMix: number;
  /** 0-0.9: how much the bird smooths out shaking */
  birdAssist: number;
  /** force other fingers may carry before the gate counts as "leaky" */
  isolationTolerance: number;
  pipeCount: number;
  focusFinger: Finger | null;
  focusBoost: number;
}

export const DEFAULT_PINCH_PARAMS: PinchParams = {
  forceLow: 0.25,
  forceHigh: 0.6,
  bandWidth: 0.26,
  holdMs: 1400,
  restMs: 1200,
  scrollMs: 3400,
  dynamicMix: 0.15,
  birdAssist: 0.5,
  isolationTolerance: 0.35,
  pipeCount: 12,
  focusFinger: null,
  focusBoost: 0,
};

export type PinchNumericKey = Exclude<keyof PinchParams, "focusFinger" | "focusBoost">;

export const PINCH_LABELS: Record<PinchNumericKey, { label: string; unit: string; digits: number }> = {
  forceLow: { label: "Lightest force", unit: "%", digits: 2 },
  forceHigh: { label: "Hardest force", unit: "%", digits: 2 },
  bandWidth: { label: "Target band", unit: "%", digits: 2 },
  holdMs: { label: "Hold time", unit: "ms", digits: 0 },
  restMs: { label: "Rest between", unit: "ms", digits: 0 },
  scrollMs: { label: "Lead time", unit: "ms", digits: 0 },
  dynamicMix: { label: "Moving targets", unit: "%", digits: 2 },
  birdAssist: { label: "Steadying help", unit: "%", digits: 2 },
  isolationTolerance: { label: "Other-finger allowance", unit: "%", digits: 2 },
  pipeCount: { label: "Gates per round", unit: "", digits: 0 },
};

/** Easiest -> hardest, in words, for the read-only sliders. */
export const PINCH_SCALE: Record<PinchNumericKey, Scale> = {
  forceLow: { easy: 0.1, hard: 0.5, words: ["Featherlight", "Light", "Gentle", "Firm", "Strong"] },
  forceHigh: { easy: 0.35, hard: 0.9, words: ["Light", "Moderate", "Firm", "Strong", "Max effort"] },
  bandWidth: { easy: 0.4, hard: 0.1, words: ["Very forgiving", "Forgiving", "Normal", "Narrow", "Pinpoint"] },
  holdMs: { easy: 800, hard: 3000, words: ["Quick tap", "Short hold", "Medium hold", "Long hold", "Very long hold"] },
  restMs: { easy: 2200, hard: 600, words: ["Plenty of rest", "Relaxed", "Normal", "Brisk", "Barely any"] },
  scrollMs: { easy: 5200, hard: 2200, words: ["Very slow", "Slow", "Medium", "Fast", "Very fast"] },
  dynamicMix: { easy: 0, hard: 0.8, words: ["All steady", "Mostly steady", "Some moving", "Often moving", "Mostly moving"] },
  birdAssist: { easy: 0.9, hard: 0, words: ["Max help", "Lots of help", "Some help", "A little help", "No help"] },
  isolationTolerance: { easy: 0.5, hard: 0.2, words: ["Fingers can wander", "Relaxed", "Balanced", "Strict", "Fully isolated"] },
  pipeCount: { easy: 8, hard: 24, words: ["Very short", "Short", "Medium", "Long", "Very long"] },
};

export function normalizePinchParams(p: Partial<PinchParams> | Record<string, unknown> | null | undefined): PinchParams {
  const out: PinchParams = { ...DEFAULT_PINCH_PARAMS };
  if (!p) return out;
  const src = p as Record<string, unknown>;
  for (const k of Object.keys(PINCH_LABELS) as PinchNumericKey[]) {
    if (typeof src[k] === "number") out[k] = src[k] as number;
  }
  out.focusBoost = typeof src.focusBoost === "number" ? src.focusBoost : 0;
  out.focusFinger = PINCH_FINGERS.includes(src.focusFinger as Finger) ? (src.focusFinger as Finger) : null;
  return out;
}

export function pinchParamsFromMeta(meta: Record<string, unknown> | undefined): PinchParams | null {
  const p = meta?.params;
  return p && typeof p === "object" ? normalizePinchParams(p as Record<string, unknown>) : null;
}

/* ----------------------------------------------------------------- round */

export type PipeKind = "static" | "step" | "ramp";
export type PipeResult = "hit" | "leak" | "miss";

export interface Pipe {
  id: number;
  finger: Finger;
  kind: PipeKind;
  /** band centre at the start and end of the gate */
  c0: number;
  c1: number;
  band: number;
  startMs: number;
  endMs: number;
  inBandMs: number;
  sampledMs: number;
  leakPeak: number;
  judged: boolean;
  result: PipeResult | null;
}

export interface PinchState {
  params: PinchParams;
  pipes: Pipe[];
  score: number;
  hits: number;
  leaks: number;
  misses: number;
  startMs: number;
  lastTickMs: number;
  finished: boolean;
}

const LEAD_IN_MS = 2200;
const END_PAD_MS = 700;
/** a gate counts as flown if the bird was in the band this share of the time */
const PASS_SHARE = 0.75;

export function centreAt(p: Pick<Pipe, "kind" | "c0" | "c1">, u: number): number {
  if (p.kind === "ramp") return p.c0 + (p.c1 - p.c0) * u;
  if (p.kind === "step") return u < 0.5 ? p.c0 : p.c1;
  return p.c0;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export function createPinch(params: PinchParams, startMs: number): PinchState {
  const bag: Finger[] = [];
  const draw = (prev: Finger | null): Finger => {
    if (params.focusFinger && Math.random() < params.focusBoost && params.focusFinger !== prev) return params.focusFinger;
    if (!bag.length) bag.push(...[...PINCH_FINGERS].sort(() => Math.random() - 0.5));
    let f = bag.shift()!;
    if (f === prev && bag.length) {
      bag.push(f);
      f = bag.shift()!;
    }
    return f;
  };

  const half = params.bandWidth / 2;
  const lo = Math.max(params.forceLow, half + 0.03);
  const hi = Math.max(lo + 0.05, Math.min(params.forceHigh, 0.97 - half));
  const pipes: Pipe[] = [];
  let t = startMs + LEAD_IN_MS;
  let prev: Finger | null = null;
  for (let i = 0; i < params.pipeCount; i++) {
    const finger = draw(prev);
    prev = finger;
    const c0 = rand(lo, hi);
    let kind: PipeKind = "static";
    let c1 = c0;
    if (Math.random() < params.dynamicMix) {
      kind = Math.random() < 0.5 ? "ramp" : "step";
      // aim for a clearly different level, on the far side of the range from c0
      const want = c0 - lo > hi - c0 ? rand(lo, Math.max(lo, c0 - 0.15)) : rand(Math.min(hi, c0 + 0.15), hi);
      c1 = want;
      if (Math.abs(c1 - c0) < 0.1) kind = "static";
    }
    pipes.push({
      id: i, finger, kind, c0, c1: kind === "static" ? c0 : c1, band: params.bandWidth,
      startMs: t, endMs: t + params.holdMs, inBandMs: 0, sampledMs: 0, leakPeak: 0, judged: false, result: null,
    });
    t += params.holdMs + params.restMs;
  }
  return { params, pipes, score: 0, hits: 0, leaks: 0, misses: 0, startMs, lastTickMs: startMs, finished: false };
}

/** The gate the bird is flying toward / through: the first one that hasn't ended. */
export function activePipe(g: PinchState, nowMs: number): Pipe | null {
  return g.pipes.find((p) => nowMs <= p.endMs) ?? null;
}

export function inGate(p: Pipe, nowMs: number): boolean {
  return nowMs >= p.startMs && nowMs <= p.endMs;
}

/**
 * Advances the round. `bird` is the (possibly steadied) force of the active finger, `others` the
 * calibrated force of every finger, used for the leak check.
 */
export function updatePinch(g: PinchState, nowMs: number, bird: number, others: Partial<Record<Finger, number>>): PinchState {
  const dt = Math.min(100, Math.max(0, nowMs - g.lastTickMs));
  let { score, hits, leaks, misses } = g;
  const pipes = g.pipes.map((p) => ({ ...p }));

  const cur = pipes.find((p) => !p.judged && nowMs >= p.startMs && nowMs <= p.endMs);
  if (cur) {
    const u = (nowMs - cur.startMs) / (cur.endMs - cur.startMs);
    cur.sampledMs += dt;
    if (Math.abs(bird - centreAt(cur, u)) <= cur.band / 2) cur.inBandMs += dt;
    const skip = new Set<Finger>([cur.finger, "thumb"]);
    const coupled = COUPLED[cur.finger];
    if (coupled) skip.add(coupled);
    for (const [f, v] of Object.entries(others) as [Finger, number][]) {
      if (!skip.has(f)) cur.leakPeak = Math.max(cur.leakPeak, v);
    }
  }

  for (const p of pipes) {
    if (p.judged || nowMs <= p.endMs) continue;
    const share = p.sampledMs > 0 ? p.inBandMs / p.sampledMs : 0;
    p.judged = true;
    if (share < PASS_SHARE) {
      p.result = "miss";
      misses++;
    } else if (p.leakPeak > g.params.isolationTolerance) {
      p.result = "leak";
      leaks++;
      score += 40;
    } else {
      p.result = "hit";
      hits++;
      score += 100 + Math.round(share * 50);
    }
  }

  const last = pipes[pipes.length - 1];
  const finished = !!last && last.judged && nowMs > last.endMs + END_PAD_MS;
  return { ...g, pipes, score, hits, leaks, misses, lastTickMs: nowMs, finished };
}

export interface PinchStats {
  hits: number;
  leaks: number;
  misses: number;
  score: number;
}

export const pinchAccuracy = (s: Pick<PinchStats, "hits" | "leaks" | "misses">) => {
  const t = s.hits + s.leaks + s.misses;
  return t ? s.hits / t : 0;
};

/** What the engine reads from `meta.pipes`. */
export function pipeRecords(g: PinchState) {
  return g.pipes
    .filter((p) => p.judged && p.result)
    .map((p) => ({
      finger: p.finger,
      start_ms: Math.round(p.startMs),
      end_ms: Math.round(p.endMs),
      kind: p.kind,
      c0: Math.round(p.c0 * 1000) / 1000,
      c1: Math.round(p.c1 * 1000) / 1000,
      band: p.band,
      result: p.result,
      in_band: p.sampledMs ? Math.round((p.inBandMs / p.sampledMs) * 1000) / 1000 : 0,
    }));
}

/** Exponential smoothing of the bird's height; `assist` 0 = raw, 0.9 = heavily steadied. */
export function steadied(prev: number, raw: number, dtMs: number, assist: number): number {
  // time constant from 0 ms (no help) to ~280 ms (full help)
  const tau = assist * 310;
  if (tau < 1) return raw;
  return prev + (raw - prev) * (1 - Math.exp(-dtMs / tau));
}
