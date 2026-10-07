/**
 * Synthesized tones for the piano game -- hit plays the finger's mapped
 * note cleanly, leak plays the same note muffled (lowpassed + quieter,
 * since a leak is a successful-but-imperfect press, not a failure), miss
 * plays a short low thud. Web Audio API, no audio files: the oscillator
 * frequencies below are standard equal-temperament values for the exact
 * notes in pianoGame.ts's FINGER_NOTE map (C4/D4/E4/G4/A4).
 */

import type { Finger } from "@/lib/pianoGame";

const NOTE_FREQUENCY_HZ: Record<Finger, number> = {
  thumb: 261.63, // C4
  index: 293.66, // D4
  middle: 329.63, // E4
  ring: 392.0, // G4
  pinky: 440.0, // A4
};

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

/** Call once from a user gesture (e.g. the Start session click) so the
 * browser doesn't block audio output for lacking user-activation. */
export function unlockAudio(): void {
  const ctx = getAudioContext();
  if (ctx.state === "suspended") {
    ctx.resume();
  }
}

export function playHit(finger: Finger): void {
  const ctx = getAudioContext();
  const freq = NOTE_FREQUENCY_HZ[finger];
  const now = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.3, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.35);
}

export function playLeak(finger: Finger): void {
  const ctx = getAudioContext();
  const freq = NOTE_FREQUENCY_HZ[finger];
  const now = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 500;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.15, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.25);
}

export function playMiss(): void {
  const ctx = getAudioContext();
  const now = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.setValueAtTime(140, now);
  osc.frequency.exponentialRampToValueAtTime(70, now + 0.15);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.2, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.18);
}
