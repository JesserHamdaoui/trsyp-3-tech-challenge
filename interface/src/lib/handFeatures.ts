/**
 * Full per-frame hand feature extraction, ported from cv-poc/features.py
 * (build_frame_record and all its helpers) into TypeScript so in-browser
 * attempts produce frames in the exact same schema as the idealized
 * reference attempts already seeded into the engine (97 piano_game
 * attempts, admin-submitted) -- same joints/fingers/relational/hand shape,
 * so scoring can compare patient attempts against that reference directly
 * with no server-side reprocessing step.
 */

import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

export type Finger = "thumb" | "index" | "middle" | "ring" | "pinky";

export const FINGER_NAMES: Finger[] = ["thumb", "index", "middle", "ring", "pinky"];

// (mcp, pip/ip, dip, tip) landmark indices per finger
export const FINGER_LANDMARKS: Record<Finger, [number, number, number, number]> = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

// triples of landmark indices (a, b, c) used to compute the flexion angle
// at joint b (angle between vectors b->a and b->c)
const JOINT_ANGLE_TRIPLES: Record<Finger, Record<string, [number, number, number]>> = {
  thumb: { mcp_angle_deg: [0, 2, 3], ip_angle_deg: [2, 3, 4] },
  index: { mcp_angle_deg: [0, 5, 6], pip_angle_deg: [5, 6, 7], dip_angle_deg: [6, 7, 8] },
  middle: { mcp_angle_deg: [0, 9, 10], pip_angle_deg: [9, 10, 11], dip_angle_deg: [10, 11, 12] },
  ring: { mcp_angle_deg: [0, 13, 14], pip_angle_deg: [13, 14, 15], dip_angle_deg: [14, 15, 16] },
  pinky: { mcp_angle_deg: [0, 17, 18], pip_angle_deg: [17, 18, 19], dip_angle_deg: [18, 19, 20] },
};

const ADJACENT_FINGER_PAIRS: [Finger, Finger][] = [
  ["thumb", "index"],
  ["index", "middle"],
  ["middle", "ring"],
  ["ring", "pinky"],
];

export const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const HISTORY_LEN = 5;
const EXTENDED_CURL_THRESHOLD = 0.35;
const SYNC_CURL_THRESHOLD = 0.5;

// see cv-poc/features.py CURL_STRAIGHTNESS_FLOOR for the calibration
// rationale (thumb's CMC-driven motion never folds as far as the other
// fingers' MCP/PIP/DIP hinge chain)
export const CURL_STRAIGHTNESS_FLOOR: Record<Finger, number> = {
  thumb: 0.83,
  index: 0.35,
  middle: 0.35,
  ring: 0.35,
  pinky: 0.35,
};

// --- vector helpers (image-space xy in pixels, xyz normalized) -------------

interface Vec2 {
  x: number;
  y: number;
}
interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function landmarkXY(landmarks: NormalizedLandmark[], idx: number, w: number, h: number): Vec2 {
  const lm = landmarks[idx];
  return { x: lm.x * w, y: lm.y * h };
}

function landmarkXYZ(landmarks: NormalizedLandmark[], idx: number): Vec3 {
  const lm = landmarks[idx];
  return { x: lm.x, y: lm.y, z: lm.z };
}

function sub2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}
function norm2(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}
function dist2(a: Vec2, b: Vec2): number {
  return norm2(sub2(a, b));
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function norm3(a: Vec3): number {
  return Math.sqrt(dot3(a, a));
}
function cross3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function angleDeg3(a: Vec3, b: Vec3, c: Vec3): number {
  const v1 = sub3(a, b);
  const v2 = sub3(c, b);
  const n1 = norm3(v1);
  const n2 = norm3(v2);
  if (n1 < 1e-9 || n2 < 1e-9) return 180.0;
  const cosAngle = Math.min(1.0, Math.max(-1.0, dot3(v1, v2) / (n1 * n2)));
  return (Math.acos(cosAngle) * 180) / Math.PI;
}

function round(v: number, digits: number): number {
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}

// --- curl / joint angles -----------------------------------------------

export function curlNormalized(landmarks: NormalizedLandmark[], finger: Finger, w: number, h: number): number {
  const [mcpI, p1I, p2I, tipI] = FINGER_LANDMARKS[finger];
  const mcp = landmarkXY(landmarks, mcpI, w, h);
  const p1 = landmarkXY(landmarks, p1I, w, h);
  const p2 = landmarkXY(landmarks, p2I, w, h);
  const tip = landmarkXY(landmarks, tipI, w, h);

  const segmentLen = dist2(p1, mcp) + dist2(p2, p1) + dist2(tip, p2);
  const tipToMcp = dist2(tip, mcp);

  if (segmentLen < 1e-6) return 0.0;

  const straightness = tipToMcp / segmentLen;
  const floor = CURL_STRAIGHTNESS_FLOOR[finger];
  const curlScaled = (1.0 - straightness) / (1.0 - floor);
  return Math.min(1.0, Math.max(0.0, curlScaled));
}

export function allCurls(landmarks: NormalizedLandmark[], w = 1, h = 1): Record<Finger, number> {
  const out = {} as Record<Finger, number>;
  for (const finger of FINGER_NAMES) {
    out[finger] = curlNormalized(landmarks, finger, w, h);
  }
  return out;
}

function jointAngles(landmarksXYZAll: Vec3[], finger: Finger): Record<string, number> {
  const triples = JOINT_ANGLE_TRIPLES[finger];
  const out: Record<string, number> = {};
  for (const [name, [a, b, c]] of Object.entries(triples)) {
    out[name] = angleDeg3(landmarksXYZAll[a], landmarksXYZAll[b], landmarksXYZAll[c]);
  }
  return out;
}

function gripState(curls: Record<Finger, number>): "closed" | "open" | "partial" {
  const avg = FINGER_NAMES.reduce((s, f) => s + curls[f], 0) / FINGER_NAMES.length;
  if (avg > 0.8) return "closed";
  if (avg < 0.2) return "open";
  return "partial";
}

function palmNormalVector(landmarksXYZAll: Vec3[]): Vec3 {
  const wrist = landmarksXYZAll[0];
  const indexMcp = landmarksXYZAll[5];
  const pinkyMcp = landmarksXYZAll[17];
  const v1 = sub3(indexMcp, wrist);
  const v2 = sub3(pinkyMcp, wrist);
  const normal = cross3(v1, v2);
  const n = norm3(normal);
  if (n < 1e-9) return { x: 0, y: 0, z: -1 };
  return { x: normal.x / n, y: normal.y / n, z: normal.z / n };
}

function handOrientationFromNormal(normal: Vec3): "palm_facing_camera" | "back_facing_camera" | "side" {
  if (normal.z < -0.5) return "palm_facing_camera";
  if (normal.z > 0.5) return "back_facing_camera";
  return "side";
}

function wristRotationDeg(landmarksXYZAll: Vec3[]): number {
  const wrist = landmarksXYZAll[0];
  const middleMcp = landmarksXYZAll[9];
  const vx = middleMcp.x - wrist.x;
  const vy = middleMcp.y - wrist.y;
  return (Math.atan2(vx, -vy) * 180) / Math.PI;
}

// --- per-attempt dynamics trackers (mirrors features.py FingerTrack/HandTrack) --

export class FingerTrack {
  private lastPos: Vec2 | null = null;
  private lastT: number | null = null;
  private lastVelocity = 0;
  private lastAcceleration = 0;
  pathLengthPx = 0;
  private velocityHistory: number[] = [];
  private curlHistory: number[] = [];

  update(pos: Vec2, t: number, curl: number) {
    let velocity = 0;
    let acceleration = 0;
    let jerk = 0;
    if (this.lastPos !== null && this.lastT !== null) {
      const dt = Math.max(t - this.lastT, 1e-6);
      const d = dist2(pos, this.lastPos);
      velocity = d / dt;
      this.pathLengthPx += d;
      acceleration = (velocity - this.lastVelocity) / dt;
      jerk = (acceleration - this.lastAcceleration) / dt;
    }

    this.lastPos = pos;
    this.lastT = t;
    this.velocityHistory.push(velocity);
    if (this.velocityHistory.length > HISTORY_LEN) this.velocityHistory.shift();
    this.curlHistory.push(curl);
    if (this.curlHistory.length > 3) this.curlHistory.shift();

    let direction: "still" | "closing" | "opening" = "still";
    if (this.curlHistory.length >= 2) {
      const delta = this.curlHistory[this.curlHistory.length - 1] - this.curlHistory[this.curlHistory.length - 2];
      if (delta > 0.02) direction = "closing";
      else if (delta < -0.02) direction = "opening";
    }

    this.lastVelocity = velocity;
    this.lastAcceleration = acceleration;
    return { velocity, acceleration, jerk, direction };
  }

  smoothness(): number {
    if (this.velocityHistory.length < 2) return 1.0;
    const mean = this.velocityHistory.reduce((s, v) => s + v, 0) / this.velocityHistory.length + 1e-6;
    const variance =
      this.velocityHistory.reduce((s, v) => s + (v - mean) ** 2, 0) / this.velocityHistory.length;
    const cv = Math.sqrt(variance) / mean;
    return Math.min(1.0, Math.max(0.0, 1.0 / (1.0 + cv)));
  }

  reset() {
    this.lastPos = null;
    this.lastT = null;
    this.lastVelocity = 0;
    this.lastAcceleration = 0;
    this.pathLengthPx = 0;
    this.velocityHistory = [];
    this.curlHistory = [];
  }
}

export class HandTrack {
  private lastCentroid: Vec2 | null = null;
  private lastT: number | null = null;

  update(centroid: Vec2, t: number): number {
    let velocity = 0;
    if (this.lastCentroid !== null && this.lastT !== null) {
      const dt = Math.max(t - this.lastT, 1e-6);
      velocity = dist2(centroid, this.lastCentroid) / dt;
    }
    this.lastCentroid = centroid;
    this.lastT = t;
    return velocity;
  }

  reset() {
    this.lastCentroid = null;
    this.lastT = null;
  }
}

// --- full frame record, matching cv-poc/features.py build_frame_record -----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FrameRecord = Record<string, any>;

export function buildFrameRecord(
  landmarks: NormalizedLandmark[],
  w: number,
  h: number,
  tNowS: number,
  frameIndex: number,
  handednessLabel: string,
  handednessConf: number,
  fingerTracks: Record<Finger, FingerTrack>,
  handTrack: HandTrack
): FrameRecord {
  const landmarksXYZAll = landmarks.map((_, i) => landmarkXYZ(landmarks, i));
  const landmarksXYAll = landmarks.map((_, i) => landmarkXY(landmarks, i, w, h));

  const curls = allCurls(landmarks, w, h);

  const jointsOut: FrameRecord = {};
  for (const name of FINGER_NAMES) {
    const angles = jointAngles(landmarksXYZAll, name); // full precision, not rounded -- matches python
    jointsOut[name] = { ...angles, curl_normalized: round(curls[name], 3) };
  }

  const fingersOut: FrameRecord = {};
  for (const name of FINGER_NAMES) {
    const tipI = FINGER_LANDMARKS[name][3];
    const tip = landmarksXYAll[tipI];
    const { velocity, acceleration, jerk, direction } = fingerTracks[name].update(tip, tNowS, curls[name]);
    fingersOut[name] = {
      curl_normalized: round(curls[name], 3),
      tip_velocity_px_s: round(velocity, 1),
      tip_acceleration_px_s2: round(acceleration, 1),
      tip_jerk_px_s3: round(jerk, 1),
      path_length_total_px: round(fingerTracks[name].pathLengthPx, 1),
      movement_smoothness_score: round(fingerTracks[name].smoothness(), 3),
      movement_direction: direction,
      finger_identity_confidence: round(handednessConf, 3),
      is_extended: curls[name] < EXTENDED_CURL_THRESHOLD,
    };
  }

  const thumbTip = landmarksXYAll[FINGER_LANDMARKS.thumb[3]];
  const indexTip = landmarksXYAll[FINGER_LANDMARKS.index[3]];
  const handSizePx = dist2(landmarksXYAll[0], landmarksXYAll[9]) * 2.0 || 1.0;
  const pinchDistNorm = dist2(thumbTip, indexTip) / handSizePx;

  const spreadAngles: Record<string, number> = {};
  for (const [f1, f2] of ADJACENT_FINGER_PAIRS) {
    const tip1 = landmarksXYAll[FINGER_LANDMARKS[f1][3]];
    const tip2 = landmarksXYAll[FINGER_LANDMARKS[f2][3]];
    const wristXY = landmarksXYAll[0];
    const v1 = sub2(tip1, wristXY);
    const v2 = sub2(tip2, wristXY);
    const n1 = norm2(v1);
    const n2 = norm2(v2);
    if (n1 > 1e-6 && n2 > 1e-6) {
      const cosA = Math.min(1.0, Math.max(-1.0, (v1.x * v2.x + v1.y * v2.y) / (n1 * n2)));
      spreadAngles[`${f1}_${f2}`] = round((Math.acos(cosA) * 180) / Math.PI, 1);
    } else {
      spreadAngles[`${f1}_${f2}`] = 0.0;
    }
  }

  const curlValues = FINGER_NAMES.map((f) => curls[f]);
  const mostCurled = FINGER_NAMES.reduce((a, b) => (curls[b] > curls[a] ? b : a));
  const leastCurled = FINGER_NAMES.reduce((a, b) => (curls[b] < curls[a] ? b : a));
  const curlMean = curlValues.reduce((s, v) => s + v, 0) / curlValues.length;
  const curlStd = Math.sqrt(curlValues.reduce((s, v) => s + (v - curlMean) ** 2, 0) / curlValues.length);
  const curlSynchronyScore = Math.min(1.0, Math.max(0.0, 1.0 - curlStd));
  const allCurledTogether =
    curlValues.every((v) => v > SYNC_CURL_THRESHOLD) || curlValues.every((v) => v < 1 - SYNC_CURL_THRESHOLD);

  const relationalOut = {
    thumb_index_pinch_distance_norm: round(pinchDistNorm, 3),
    finger_spread_angles_deg: spreadAngles,
    most_curled_finger: mostCurled,
    least_curled_finger: leastCurled,
    curl_synchrony_score: round(curlSynchronyScore, 3),
    all_fingers_curled_together: allCurledTogether,
  };

  const wristXY = landmarksXYAll[0];
  const centroid = landmarksXYAll.reduce(
    (acc, p) => ({ x: acc.x + p.x / 21, y: acc.y + p.y / 21 }),
    { x: 0, y: 0 }
  );
  const normal = palmNormalVector(landmarksXYZAll);
  const handVelocity = handTrack.update(centroid, tNowS);

  const xs = landmarksXYAll.map((p) => p.x);
  const ys = landmarksXYAll.map((p) => p.y);
  const xMin = Math.min(...xs);
  const yMin = Math.min(...ys);
  const xMax = Math.max(...xs);
  const yMax = Math.max(...ys);

  const handOut = {
    wrist_position_xy: { x: round(wristXY.x, 1), y: round(wristXY.y, 1) },
    hand_centroid_xy: { x: round(centroid.x, 1), y: round(centroid.y, 1) },
    hand_position_normalized: { x: round(centroid.x / w, 3), y: round(centroid.y / h, 3) },
    hand_size_px: round(handSizePx, 1),
    palm_normal_vector: { x: round(normal.x, 3), y: round(normal.y, 3), z: round(normal.z, 3) },
    hand_orientation: handOrientationFromNormal(normal),
    wrist_rotation_deg: round(wristRotationDeg(landmarksXYZAll), 1),
    bounding_box_norm: {
      x_min: round(xMin / w, 3),
      y_min: round(yMin / h, 3),
      x_max: round(xMax / w, 3),
      y_max: round(yMax / h, 3),
    },
    hand_velocity_px_s: round(handVelocity, 1),
    grip_state: gripState(curls),
  };

  const rawLandmarks = landmarks.map((lm) => ({ x: lm.x, y: lm.y, z: lm.z }));

  return {
    timestamp_ms: Math.round(tNowS * 1000),
    frame_index: frameIndex,
    hand_detected: true,
    handedness: handednessLabel,
    handedness_confidence: round(handednessConf, 3),
    joints: jointsOut,
    fingers: fingersOut,
    relational: relationalOut,
    hand: handOut,
    raw_landmarks: rawLandmarks,
  };
}

export function emptyFrameRecord(tNowS: number, frameIndex: number): FrameRecord {
  return {
    timestamp_ms: Math.round(tNowS * 1000),
    frame_index: frameIndex,
    hand_detected: false,
  };
}
