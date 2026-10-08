/**
 * The sensor glove, as the games see it.
 *
 * The real glove has one force-sensing resistor (FSR) per fingertip and an IMU on the palm. It will
 * stream `GlovePacket`s; a game subscribes to a `GloveSource` and never knows what is behind it.
 * Until the hardware exists, `CameraGlove` makes the same packets out of the webcam's hand landmarks:
 *
 *   FSR  <- closeness of the thumb tip to each fingertip (a pinch is how the force would be applied)
 *   IMU  <- second derivative of the palm's position (accel) and its rotation rate (gyro)
 *
 * Swapping in the real glove means writing another `GloveSource` (Web Bluetooth / Web Serial) that
 * emits packets of this shape; the game, the calibration and the engine's features stay as they are.
 *
 * Packet values:
 *   t     ms on the page's `performance.now()` clock (the real glove's own clock must be mapped onto it)
 *   fsr   raw sensor readout per finger, higher = more force. Units are the source's own, which is why
 *         every game calibrates (`rest` = nothing applied, `max` = the patient's firmest pinch).
 *   imu   ax/ay/az in g, gx/gy/gz in deg/s. Gravity may or may not be included: consumers high-pass.
 */

import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { FINGER_NAMES, FINGER_LANDMARKS, type Finger } from "@/lib/handFeatures";

export interface ImuSample {
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
}

export interface GlovePacket {
  t: number;
  fsr: Record<Finger, number>;
  imu: ImuSample;
}

export interface GloveSource {
  readonly kind: "camera-sim" | "ble" | "serial";
  readonly label: string;
  subscribe(cb: (packet: GlovePacket) => void): () => void;
  close(): void;
}

/* ------------------------------------------------------------ calibration */

export interface FingerCalibration {
  /** raw readout with nothing applied */
  rest: number;
  /** raw readout at the patient's firmest pinch */
  max: number;
}
export type Calibration = Partial<Record<Finger, FingerCalibration>>;

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Raw readout -> 0-1 of the patient's own range. */
export function forceOf(raw: number, c: FingerCalibration | undefined): number {
  if (!c) return 0;
  return clamp01((raw - c.rest) / Math.max(1e-3, c.max - c.rest));
}

export function forces(packet: GlovePacket, cal: Calibration): Record<Finger, number> {
  const out = {} as Record<Finger, number>;
  for (const f of FINGER_NAMES) out[f] = forceOf(packet.fsr[f] ?? 0, cal[f]);
  return out;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

/* ------------------------------------------------- camera-made glove data */

const PALM = [0, 5, 9, 13, 17];
/** wrist -> middle knuckle x2 is roughly this long on an adult hand; turns "hand sizes" into metres */
const HAND_SIZE_M = 0.18;
const G = 9.81;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const norm = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const unit = (a: Vec3): Vec3 => {
  const n = norm(a) || 1;
  return { x: a.x / n, y: a.y / n, z: a.z / n };
};

interface PalmSample {
  t: number;
  pos: Vec3; // in hand sizes
  normal: Vec3;
  roll: number; // rad, wrist -> middle-knuckle direction in the image plane (unwrapped)
}

export class CameraGlove implements GloveSource {
  readonly kind = "camera-sim" as const;
  readonly label = "Camera (simulated glove)";

  private subs = new Set<(p: GlovePacket) => void>();
  private hist: PalmSample[] = [];
  private smoothed: Vec3 | null = null;

  subscribe(cb: (p: GlovePacket) => void) {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  close() {
    this.subs.clear();
    this.hist = [];
  }

  /** Feed one camera frame. With no hand the glove stays silent, as a glove that lost power would. */
  ingest(landmarks: NormalizedLandmark[] | null, w: number, h: number, tMs: number): GlovePacket | null {
    if (!landmarks) {
      this.hist = [];
      this.smoothed = null;
      return null;
    }
    const px = (i: number): Vec3 => ({ x: landmarks[i].x * w, y: landmarks[i].y * h, z: landmarks[i].z * w });
    const wrist = px(0);
    const size = Math.max(1, Math.hypot(px(9).x - wrist.x, px(9).y - wrist.y) * 2);

    // FSR: how close each fingertip is to the thumb tip, 0 (far) .. 1 (touching)
    const thumbTip = px(FINGER_LANDMARKS.thumb[3]);
    const fsr = {} as Record<Finger, number>;
    for (const f of FINGER_NAMES) {
      if (f === "thumb") continue;
      const tip = px(FINGER_LANDMARKS[f][3]);
      fsr[f] = clamp01(1 - Math.hypot(tip.x - thumbTip.x, tip.y - thumbTip.y, (tip.z - thumbTip.z) * 0.5) / size);
    }
    fsr.thumb = Math.max(fsr.index, fsr.middle, fsr.ring, fsr.pinky); // the thumb pad meets whichever finger pinches

    // IMU: palm centre, normal and roll, differentiated over the last few frames
    const c = PALM.reduce((a, i) => ({ x: a.x + px(i).x / PALM.length, y: a.y + px(i).y / PALM.length, z: a.z + px(i).z / PALM.length }), { x: 0, y: 0, z: 0 });
    const raw: Vec3 = { x: c.x / size, y: c.y / size, z: c.z / size };
    // light smoothing so landmark jitter does not read as a tremor
    const sm = this.smoothed ? { x: this.smoothed.x + 0.6 * (raw.x - this.smoothed.x), y: this.smoothed.y + 0.6 * (raw.y - this.smoothed.y), z: this.smoothed.z + 0.6 * (raw.z - this.smoothed.z) } : raw;
    this.smoothed = sm;

    const normal = unit(cross(sub(px(5), wrist), sub(px(17), wrist)));
    let roll = Math.atan2(px(9).x - wrist.x, -(px(9).y - wrist.y));
    const last = this.hist[this.hist.length - 1];
    if (last) {
      while (roll - last.roll > Math.PI) roll -= 2 * Math.PI;
      while (roll - last.roll < -Math.PI) roll += 2 * Math.PI;
    }
    const cur: PalmSample = { t: tMs, pos: sm, normal, roll };
    if (last && (tMs - last.t > 250 || tMs - last.t < 1)) this.hist = [];
    this.hist.push(cur);
    if (this.hist.length > 3) this.hist.shift();

    let imu: ImuSample = { ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0 };
    if (this.hist.length === 3) {
      const [a, b, d] = this.hist;
      const dt1 = (b.t - a.t) / 1000;
      const dt2 = (d.t - b.t) / 1000;
      const toG = (dp: number) => (dp * HAND_SIZE_M) / G;
      const acc = (k: "x" | "y" | "z") => toG((2 * ((d.pos[k] - b.pos[k]) / dt2 - (b.pos[k] - a.pos[k]) / dt1)) / (dt1 + dt2));
      const n0 = b.normal;
      const n1 = d.normal;
      const wv = cross(n0, n1); // axis * sin(angle)
      const deg = 180 / Math.PI;
      imu = {
        ax: acc("x"),
        ay: acc("y"),
        az: acc("z") * 0.5, // MediaPipe's depth is the least trustworthy axis
        gx: (wv.x / dt2) * deg,
        gy: (wv.y / dt2) * deg,
        gz: ((d.roll - b.roll) / dt2) * deg,
      };
    }

    const packet: GlovePacket = { t: tMs, fsr, imu };
    this.subs.forEach((cb) => cb(packet));
    return packet;
  }
}
