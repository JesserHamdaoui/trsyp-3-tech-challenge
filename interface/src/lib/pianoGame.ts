/**
 * Piano game logic, ported from cv-poc/piano_game.py (PianoGame/Note
 * classes) into TypeScript. Judges notes against the CV server's live
 * curl values -- the target finger must curl past target_curl_threshold
 * within the timing window, and no other finger (except the anatomically
 * coupled ring/pinky pair) may exceed isolation_tolerance at the same
 * moment, or the hit counts as a "leak" instead of a clean "hit".
 */

export type Finger = "thumb" | "index" | "middle" | "ring" | "pinky";

export const ACTIVE_FINGERS: Finger[] = ["thumb", "index", "middle", "ring", "pinky"];

export const FINGER_NOTE: Record<Finger, string> = {
  thumb: "C4",
  index: "D4",
  middle: "E4",
  ring: "G4",
  pinky: "A4",
};

const ANATOMICALLY_COUPLED_PAIRS = new Set(["ring:pinky", "pinky:ring"]);

export interface GameParams {
  targetCurlThreshold: number;
  isolationTolerance: number;
  timingWindowMs: number;
  noteFallMs: number;
  sequenceLength: number;
}

export const DEFAULT_PARAMS: GameParams = {
  targetCurlThreshold: 0.65,
  isolationTolerance: 0.35,
  timingWindowMs: 350,
  noteFallMs: 1800,
  sequenceLength: 16,
};

export type NoteResult = "hit" | "leak" | "miss";

export interface Note {
  id: number;
  finger: Finger;
  spawnedAtMs: number;
  fallMs: number;
  hitAtMs: number;
  judged: boolean;
  result: NoteResult | null;
}

export interface GameState {
  params: GameParams;
  notes: Note[];
  score: number;
  hits: number;
  leaks: number;
  misses: number;
  spawned: number;
  finished: boolean;
  waitingToStart: boolean;
  roundStartMs: number | null;
  nextSpawnMs: number | null;
  spawnGapMs: number;
  nextNoteId: number;
}

export function createGame(params: Partial<GameParams> = {}): GameState {
  const merged = { ...DEFAULT_PARAMS, ...params };
  return {
    params: merged,
    notes: [],
    score: 0,
    hits: 0,
    leaks: 0,
    misses: 0,
    spawned: 0,
    finished: false,
    waitingToStart: true,
    roundStartMs: null,
    nextSpawnMs: null,
    spawnGapMs: merged.noteFallMs / 1.6,
    nextNoteId: 1,
  };
}

export function startRound(game: GameState, nowMs: number): GameState {
  const fresh = createGame(game.params);
  fresh.waitingToStart = false;
  fresh.roundStartMs = nowMs;
  fresh.nextSpawnMs = nowMs + 500;
  return fresh;
}

function noteY(note: Note, nowMs: number): number {
  const elapsed = nowMs - note.spawnedAtMs;
  return elapsed / note.fallMs; // 0 at spawn, 1 at hit line
}

export function maybeSpawn(game: GameState, nowMs: number): GameState {
  if (game.waitingToStart) return game;
  if (game.finished || game.spawned >= game.params.sequenceLength) {
    if (game.notes.length === 0 && game.spawned >= game.params.sequenceLength && !game.finished) {
      return { ...game, finished: true };
    }
    return game;
  }
  if (game.nextSpawnMs !== null && nowMs >= game.nextSpawnMs) {
    const finger = ACTIVE_FINGERS[Math.floor(Math.random() * ACTIVE_FINGERS.length)];
    const note: Note = {
      id: game.nextNoteId,
      finger,
      spawnedAtMs: nowMs,
      fallMs: game.params.noteFallMs,
      hitAtMs: nowMs + game.params.noteFallMs,
      judged: false,
      result: null,
    };
    return {
      ...game,
      notes: [...game.notes, note],
      spawned: game.spawned + 1,
      nextSpawnMs: nowMs + game.spawnGapMs,
      nextNoteId: game.nextNoteId + 1,
    };
  }
  return game;
}

export function updateGame(game: GameState, nowMs: number, curls: Partial<Record<Finger, number>>): GameState {
  if (game.waitingToStart) return game;

  const windowMs = game.params.timingWindowMs;
  const threshold = game.params.targetCurlThreshold;
  const tolerance = game.params.isolationTolerance;

  let { score, hits, leaks, misses } = game;
  const notes = game.notes.map((note): Note => {
    if (note.judged) return note;

    if (nowMs > note.hitAtMs + windowMs) {
      misses += 1;
      return { ...note, judged: true, result: "miss" };
    }

    if (Math.abs(nowMs - note.hitAtMs) <= windowMs) {
      const targetCurled = (curls[note.finger] ?? 0) >= threshold;
      if (targetCurled) {
        const leaking = ACTIVE_FINGERS.some(
          (f) =>
            f !== note.finger &&
            (curls[f] ?? 0) > tolerance &&
            !ANATOMICALLY_COUPLED_PAIRS.has(`${note.finger}:${f}`)
        );
        if (leaking) {
          leaks += 1;
          score += 2;
          return { ...note, judged: true, result: "leak" };
        } else {
          hits += 1;
          score += 10;
          return { ...note, judged: true, result: "hit" };
        }
      }
    }
    return note;
  });

  const keptNotes = notes.filter((n) => !(n.judged && nowMs - n.hitAtMs > windowMs + 400));

  return { ...game, notes: keptNotes, score, hits, leaks, misses };
}

export function currentPromptFinger(game: GameState): Finger | null {
  const pending = game.notes.filter((n) => !n.judged);
  if (pending.length === 0) return null;
  return pending.reduce((soonest, n) => (n.hitAtMs < soonest.hitAtMs ? n : soonest)).finger;
}

export function noteProgress(note: Note, nowMs: number): number {
  return noteY(note, nowMs);
}
