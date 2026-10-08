/**
 * Hand orientation for the 3D twin, from MediaPipe landmarks.
 *
 * Both the live hand and the rigged model get a frame from the same definition:
 *   up   = wrist -> middle knuckle
 *   side = pinky knuckle -> index knuckle (points to the thumb side, whatever the hand)
 *   n    = side x up
 * and the twin is rotated by the rotation that carries the model's frame onto the hand's. Coordinates are
 * mirrored in x, so it moves like a selfie preview; the twin stays centred, only its orientation, finger
 * spread and finger curl follow the hand.
 *
 * Left and right hands differ by a reflection, which no rotation can express. The twin takes the first
 * pose it sees as "palm toward the camera" and, if needed, mirrors the model (scale.x = -1) so the palm
 * agrees; `chirality` records that choice until the hand has been gone for a while.
 */

import * as THREE from "three";

export interface Lm {
  x: number;
  y: number;
  z: number;
}

export interface Frame {
  s: THREE.Vector3;
  y: THREE.Vector3;
  n: THREE.Vector3;
}

const MIRROR = new THREE.Matrix4().makeScale(-1, 1, 1);

/** Landmark -> twin world coordinates: x mirrored, y up, z toward the viewer. */
export const toWorld = (lm: Lm, w: number, h: number) => new THREE.Vector3(-lm.x * w, -lm.y * h, -lm.z * w);

export function frameOf(side: THREE.Vector3, up: THREE.Vector3): Frame {
  const y = up.clone().normalize();
  const s = side.clone().sub(y.clone().multiplyScalar(side.dot(y))).normalize();
  const n = new THREE.Vector3().crossVectors(s, y);
  return { s, y, n };
}

export function handFrame(lms: Lm[], w: number, h: number): Frame {
  const P = (i: number) => toWorld(lms[i], w, h);
  return frameOf(P(5).sub(P(17)), P(9).sub(P(0)));
}

const basis = (s: THREE.Vector3, y: THREE.Vector3, n: THREE.Vector3) => new THREE.Matrix4().makeBasis(s, y, n);

/** The rotation to give the twin, plus the x scale (1, or -1 for the mirrored model). */
export function orientation(hand: Frame, model: Frame, chirality: 1 | -1): { q: THREE.Quaternion; flip: 1 | -1 } {
  const modelInv = basis(model.s, model.y, model.n).transpose();
  const m =
    chirality === 1
      ? basis(hand.s, hand.y, hand.n).multiply(modelInv)
      : basis(hand.s, hand.y, hand.n.clone().negate()).multiply(modelInv).multiply(MIRROR);
  return { q: new THREE.Quaternion().setFromRotationMatrix(m), flip: chirality };
}

/** Which way the model palm (its +z) points in the world after `orientation`; > 0 faces the viewer. */
export function palmFacing(hand: Frame, model: Frame, chirality: 1 | -1): number {
  const { q } = orientation(hand, model, chirality);
  return new THREE.Vector3(0, 0, 1).applyQuaternion(q).z;
}

/** Sideways angle of a finger's proximal bone, from the hand's up axis toward the thumb side (rad). */
export function sideAngle(v: THREE.Vector3, f: Frame): number {
  return Math.atan2(v.dot(f.s), v.dot(f.y));
}

export const FINGER_MCP_PIP: Record<"index" | "middle" | "ring" | "pinky", [number, number]> = {
  index: [5, 6],
  middle: [9, 10],
  ring: [13, 14],
  pinky: [17, 18],
};
