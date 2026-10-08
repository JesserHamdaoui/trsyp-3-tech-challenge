"use client";

/**
 * Live 3D hand digital twin (Three.js) driving the rigged FBX hand (public/simplehand.fbx) from the live
 * hand's landmarks.
 *
 * The twin stays centred in its frame, but copies the hand: its overall orientation (lib/handPose.ts) and
 * the direction of every finger segment. The rig has one bone per joint (a palm-side base bone, then the
 * knuckle, middle and end-joint bones of each finger; for the thumb the base bone is the metacarpal), and
 * the segment that follows each joint matches one landmark pair (e.g. index 5->6, 6->7, 7->8). Each frame
 * the hand's segment directions, taken in the hand's own frame, are carried onto the model's frame, and
 * every driven bone is turned so its segment points that way (a swing from its bind pose). Nothing is
 * derived from a curl number, so any pose the hand makes (partial curls, spread, a pinching thumb) is
 * reproduced as seen. Directions are eased in time, so landmark noise never shows.
 *
 * simplehand.fbx has 21 bones: one root (wrist) plus five 4-bone finger chains with generic names
 * (Bone, Bone001..Bone020); the finger<->chain mapping was determined from bind-pose world positions.
 *
 * The highlighted finger's colour is applied per vertex (one continuous skinned mesh, no per-finger
 * submesh to retint): each vertex's skin weight on a finger's bones becomes a soft mask.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { Finger } from "@/lib/handFeatures";
import { frameOf, handFrame, orientation, palmFacing, toWorld, type Frame, type Lm } from "@/lib/handPose";

const FINGER_CHAINS: Record<Finger, [string, string, string, string]> = {
  thumb: ["Bone001", "Bone002", "Bone003", "Bone004"],
  index: ["Bone005", "Bone006", "Bone007", "Bone008"],
  middle: ["Bone009", "Bone010", "Bone011", "Bone012"],
  ring: ["Bone013", "Bone014", "Bone015", "Bone016"],
  pinky: ["Bone017", "Bone018", "Bone019", "Bone020"],
};

/** Driven bones per finger: [index into FINGER_CHAINS, landmark the segment starts at, landmark it ends at]. */
const DRIVEN: Record<Finger, [number, number, number][]> = {
  thumb: [[0, 1, 2], [1, 2, 3], [2, 3, 4]],
  index: [[1, 5, 6], [2, 6, 7], [3, 7, 8]],
  middle: [[1, 9, 10], [2, 10, 11], [3, 11, 12]],
  ring: [[1, 13, 14], [2, 14, 15], [3, 15, 16]],
  pinky: [[1, 17, 18], [2, 18, 19], [3, 19, 20]],
};

const FINGER_NOTE_COLOR: Record<Finger, THREE.Color> = {
  thumb: new THREE.Color(0xffd84a), // matches pianoGame page's FINGER_COLOR
  index: new THREE.Color(0x4aa8ff),
  middle: new THREE.Color(0x27e0c0),
  ring: new THREE.Color(0xc79bff),
  pinky: new THREE.Color(0xff4f8b),
};
const DEFAULT_COLOR = new THREE.Color(0xe9c9ad); // skin tone, baked into the vertex colors (material stays white)

/** Landmarks of the live hand (normalized image coords) and the frame size they were measured in. */
export interface HandPose {
  landmarks: Lm[];
  w: number;
  h: number;
}

export interface HandTwin3DHandle {
  /** `pose`: the hand to follow; `null` = hand lost (the twin eases back to upright); omitted = keep the last one */
  update: (curls: Partial<Record<Finger, number>>, highlightFinger: Finger | null, pose?: HandPose | null) => void;
  /** Which hand is being tracked. Set, it replaces the "first pose is palm-forward" guess; null goes back to guessing. */
  setHand: (hand: "left" | "right" | null) => void;
}

export default function HandTwin3D({
  width = 320,
  height = 320,
  handleRef,
}: {
  width?: number;
  height?: number;
  handleRef: React.MutableRefObject<HandTwin3DHandle | null>;
}) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);

    const camera = new THREE.PerspectiveCamera(45, width / height, 1, 1000000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0xb9a99a, 1.0));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
    dirLight.position.set(0.6, 1.2, 1.5);
    scene.add(dirLight);

    let disposed = false;
    let animId: number;
    // per finger: the static parent's world rotation and the driven bones (see DRIVEN)
    interface Driven {
      bone: THREE.Bone;
      restWorldQ: THREE.Quaternion; // world rotation at bind pose
      restDir: THREE.Vector3; // world direction of the bone's segment at bind pose
      from: number;
      to: number;
      restComps: THREE.Vector3; // restDir in the model frame (s, y, n components)
    }
    let rig: Record<Finger, { parentQ: THREE.Quaternion; bones: Driven[] }> | null = null;
    // per-vertex finger assignment, built once after load from skin weights
    let fingerMasks: Record<Finger, Float32Array> | null = null;
    let colorAttr: THREE.BufferAttribute | null = null;
    let lastHighlight: Finger | null | undefined = undefined;
    // the twin hangs off a pivot at the hand's centre, so it turns in place and stays centred
    const pivot = new THREE.Group();
    scene.add(pivot);
    let modelFrame: Frame | null = null;

    const loader = new FBXLoader();
    loader.load(
      "/simplehand.fbx",
      (object) => {
        if (disposed) return;

        object.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const dist = size.length() * 1.35; // room to turn without leaving the frame
        camera.position.set(0, 0, dist);
        camera.lookAt(0, 0, 0);

        const bones = new Map<string, THREE.Bone>();
        let skinnedMesh: THREE.SkinnedMesh | null = null;
        object.traverse((child) => {
          if ((child as THREE.Bone).isBone) {
            const bone = child as THREE.Bone;
            bones.set(bone.name, bone);
          }
          if ((child as THREE.SkinnedMesh).isSkinnedMesh) {
            skinnedMesh = child as THREE.SkinnedMesh;
          }
        });
        // The model's own hand frame (same definition as the live hand's), then each driven bone's bind-pose
        // world rotation and segment direction.
        const wp = (b: THREE.Object3D) => b.getWorldPosition(new THREE.Vector3());
        const bw = (name: string) => bones.get(name);
        // knuckle bones (not the palm-base ones, which all sit on one point)
        const wrist = bw("Bone"), ib = bw("Bone006"), mb = bw("Bone010"), pb = bw("Bone018");
        if (wrist && ib && mb && pb) {
          modelFrame = frameOf(wp(ib).sub(wp(pb)), wp(mb).sub(wp(wrist)));
          const mf = modelFrame;
          const built = {} as NonNullable<typeof rig>;
          for (const f of Object.keys(DRIVEN) as Finger[]) {
            const chain = FINGER_CHAINS[f];
            const list: Driven[] = [];
            for (const [ci, from, to] of DRIVEN[f]) {
              const bone = bones.get(chain[ci]);
              const next = bones.get(chain[Math.min(3, ci + 1)]);
              const prev = bones.get(chain[Math.max(0, ci - 1)]);
              if (!bone || !next || !prev) continue;
              // the leaf bone has no child, so the segment continues the previous one
              const dir = (next === bone ? wp(bone).sub(wp(prev)) : wp(next).sub(wp(bone))).normalize();
              list.push({
                bone,
                restWorldQ: bone.getWorldQuaternion(new THREE.Quaternion()),
                restDir: dir,
                from,
                to,
                restComps: new THREE.Vector3(dir.dot(mf.s), dir.dot(mf.y), dir.dot(mf.n)),
              });
            }
            const parentQ = list[0]?.bone.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
            built[f] = { parentQ, bones: list };
          }
          rig = built;
        }

        if (skinnedMesh) {
          const mesh = skinnedMesh as THREE.SkinnedMesh;
          mesh.material = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.75, metalness: 0 });

          // Soft finger masks: per vertex, how much of its skin weight sits on each
          // finger's bendable bones (chain[1..3], not the palm-side base bone), so the
          // highlight fades smoothly instead of cutting along triangle edges.
          const skeleton = mesh.skeleton;
          const boneIndexToFinger = skeleton.bones.map((b) => {
            for (const f of Object.keys(FINGER_CHAINS) as Finger[]) {
              if (FINGER_CHAINS[f].slice(1).includes(b.name)) return f;
            }
            return null;
          });

          const geometry = mesh.geometry;
          const skinIndexAttr = geometry.getAttribute("skinIndex");
          const skinWeightAttr = geometry.getAttribute("skinWeight");
          const vertexCount = geometry.getAttribute("position").count;

          const masks: Record<Finger, Float32Array> = {
            thumb: new Float32Array(vertexCount),
            index: new Float32Array(vertexCount),
            middle: new Float32Array(vertexCount),
            ring: new Float32Array(vertexCount),
            pinky: new Float32Array(vertexCount),
          };
          if (skinIndexAttr && skinWeightAttr) {
            for (let v = 0; v < vertexCount; v++) {
              for (let k = 0; k < 4; k++) {
                const f = boneIndexToFinger[skinIndexAttr.getComponent(v, k)];
                if (f) masks[f][v] += skinWeightAttr.getComponent(v, k);
              }
            }
          }
          fingerMasks = masks;

          const colors = new Float32Array(vertexCount * 3);
          for (let v = 0; v < vertexCount; v++) {
            colors[v * 3] = DEFAULT_COLOR.r;
            colors[v * 3 + 1] = DEFAULT_COLOR.g;
            colors[v * 3 + 2] = DEFAULT_COLOR.b;
          }
          colorAttr = new THREE.BufferAttribute(colors, 3);
          geometry.setAttribute("color", colorAttr);
        }

        object.position.sub(center); // centre of the open hand = pivot origin
        pivot.add(object);
      },
      undefined,
      (err) => {
        console.error("HandTwin3D: failed to load simplehand.fbx", err);
      }
    );

    // Everything follows the hand through easing: update() only records targets, the render loop moves
    // toward them. The easing is time-based (same feel at any frame rate) and adaptive: small wobbles
    // are smoothed hard, real movements get through quickly.
    const targetQuat = new THREE.Quaternion();
    const shownQuat = new THREE.Quaternion();
    let targetFlip: 1 | -1 = 1;
    let chirality: 1 | -1 | null = null;
    let forced: 1 | -1 | null = null; // the model is a right hand seen in a selfie view: right = 1, left = mirrored
    let lastSeen = 0;
    // segment directions in the hand's own frame (s, y, n components), per bone, eased
    const targetDir = new Map<THREE.Bone, THREE.Vector3>();
    const shownDir = new Map<THREE.Bone, THREE.Vector3>();
    const tmpQ = new THREE.Quaternion();
    const tmpV = new THREE.Vector3();

    const applyPose = () => {
      if (!rig || !modelFrame) return;
      const mf = modelFrame;
      const c = chirality ?? 1;
      for (const finger of Object.keys(rig) as Finger[]) {
        const { parentQ, bones } = rig[finger];
        let parentWorld = parentQ;
        for (const d of bones) {
          const shown = shownDir.get(d.bone);
          // hand-frame components -> the model's local directions (a mirrored model flips the n component)
          const dir = shown
            ? tmpV.set(0, 0, 0).addScaledVector(mf.s, shown.x).addScaledVector(mf.y, shown.y).addScaledVector(mf.n, c * shown.z).normalize()
            : d.restDir;
          const worldQ = tmpQ.setFromUnitVectors(d.restDir, dir).multiply(d.restWorldQ).clone();
          d.bone.quaternion.copy(parentWorld).invert().multiply(worldQ);
          parentWorld = worldQ;
        }
      }
    };

    const renderLoop = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - lastT) / 1000));
      lastT = now;
      if (now - lastSeen > 1500 && lastSeen > 0) {
        // hand gone for a while: settle back to the rest pose, and forget which hand it was
        chirality = forced;
        targetQuat.identity();
        targetFlip = forced ?? 1;
        if (rig && modelFrame) {
          for (const f of Object.keys(rig) as Finger[]) for (const d of rig[f].bones) targetDir.set(d.bone, d.restComps.clone());
        }
      }
      const angle = shownQuat.angleTo(targetQuat);
      const tauQ = angle < 0.06 ? 0.12 : angle < 0.3 ? 0.07 : 0.04;
      shownQuat.slerp(targetQuat, 1 - Math.exp(-dt / tauQ));
      pivot.quaternion.copy(shownQuat);
      pivot.scale.x = targetFlip; // a mirrored copy of the model for the other hand, chosen once per sighting

      for (const [bone, target] of targetDir) {
        let shown = shownDir.get(bone);
        if (!shown) shownDir.set(bone, (shown = target.clone()));
        const diff = shown.angleTo(target);
        const tau = diff < 0.05 ? 0.09 : diff < 0.25 ? 0.055 : 0.03;
        shown.lerp(target, 1 - Math.exp(-dt / tau)).normalize();
      }
      applyPose();
      renderer.render(scene, camera);
      animId = requestAnimationFrame(renderLoop);
    };
    let lastT = performance.now();
    animId = requestAnimationFrame(renderLoop);

    handleRef.current = {
      setHand(hand) {
        forced = hand === null ? null : hand === "right" ? 1 : -1;
        chirality = forced;
        targetFlip = forced ?? 1;
      },
      update(_curls: Partial<Record<Finger, number>>, highlightFinger: Finger | null, pose?: HandPose | null) {
        if (pose && modelFrame && rig) {
          lastSeen = performance.now();
          const hand = handFrame(pose.landmarks, pose.w, pose.h);
          if (forced !== null) chirality = forced;
          else if (chirality === null) {
            // first sighting: assume the palm faces the camera, and mirror the model if that needs it
            const a = palmFacing(hand, modelFrame, 1);
            if (Math.abs(a) > 0.3) chirality = a > 0 ? 1 : -1;
          }
          const c = chirality ?? 1;
          const { q } = orientation(hand, modelFrame, c);
          if (shownQuat.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w); // shortest way round
          targetQuat.copy(q);
          targetFlip = c;
          for (const f of Object.keys(rig) as Finger[]) {
            for (const d of rig[f].bones) {
              const v = toWorld(pose.landmarks[d.to], pose.w, pose.h).sub(toWorld(pose.landmarks[d.from], pose.w, pose.h)).normalize();
              targetDir.set(d.bone, new THREE.Vector3(v.dot(hand.s), v.dot(hand.y), v.dot(hand.n)));
            }
          }
        }
        if (fingerMasks && colorAttr && highlightFinger !== lastHighlight) {
          lastHighlight = highlightFinger;
          const highlightColor = highlightFinger ? FINGER_NOTE_COLOR[highlightFinger] : null;
          const mask = highlightFinger ? fingerMasks[highlightFinger] : null;
          const mixed = new THREE.Color();
          for (let v = 0; v < colorAttr.count; v++) {
            const w = mask ? THREE.MathUtils.smoothstep(mask[v], 0.04, 0.45) : 0;
            const c = highlightColor && w > 0 ? mixed.copy(DEFAULT_COLOR).lerp(highlightColor, w) : DEFAULT_COLOR;
            colorAttr.setXYZ(v, c.r, c.g, c.b);
          }
          colorAttr.needsUpdate = true;
        }
      },
    };

    return () => {
      disposed = true;
      cancelAnimationFrame(animId);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={mountRef} style={{ width, height }} />;
}
