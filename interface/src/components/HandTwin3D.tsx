"use client";

/**
 * Live 3D hand digital twin, Three.js, driving a rigged FBX hand model
 * (public/simplehand.fbx) from the game's per-finger curl values (0 =
 * straight, 1 = fully curled) rather than full landmark-direction tracking.
 * The hand itself stays in a fixed palm-facing-camera pose; only the finger
 * bones animate, each bending by its own curl scalar -- this is simpler and
 * more stable than mirroring every live landmark, and matches what the
 * game actually judges (curl thresholds), not whole-hand orientation.
 *
 * simplehand.fbx has 21 bones: one root (wrist) plus five 4-bone finger
 * chains. Bone names are generic (Bone, Bone001..Bone020) with no semantic
 * naming; the finger<->chain mapping below was determined by inspecting
 * bind-pose world positions directly -- Bone001's chain sits distinctly
 * lower/more lateral than the other four (anatomically correct for a
 * thumb), and the remaining four chains' fingertip X positions increase
 * monotonically left-to-right, matching index -> middle -> ring -> pinky
 * across the palm.
 *
 * Curl bends each of a finger's 3 rotating bones (the chain's first bone
 * is the MCP-anchor base and stays fixed -- only bones 2-4, i.e. the
 * pip/dip/tip segments, bend) evenly, so curl=1 means each bends by the
 * same angle. Each bone bends around its OWN flexion axis, derived once at
 * load time from bind-pose geometry: that bone's own "toward its child"
 * direction crossed with the palm normal, converted into the bone's local
 * space. A single shared axis (tried world-space and local-space variants)
 * does not work here because each finger chain carries a different small
 * baked-in rest rotation, so the same axis points a different physical
 * direction relative to each bone's own geometry -- deriving the axis from
 * each bone's own child direction sidesteps that entirely.
 *
 * The highlighted finger's note color is applied per-vertex (not to the
 * whole mesh's material) since this is one continuous skinned mesh with no
 * separate per-finger submesh to retint. Each vertex's dominant bone
 * (highest skin weight) is looked up once after load and mapped to a
 * finger; on highlight change, only that finger's vertices get repainted
 * into a THREE.BufferAttribute("color") the material reads via
 * vertexColors, everything else stays the base gray.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { Finger } from "@/lib/handFeatures";

const MAX_CURL_RADIANS = (260 * Math.PI) / 180; // total bend at curl=1, split evenly across 3 joints -- tuned so curl=1 brings the fingertip to the palm
// Palm normal in world space at bind pose (palm faces -Z toward camera),
// confirmed by direct bind-pose measurement. Each rotating bone's own flex
// axis is derived from this at load time (see computeFlexAxis below) rather
// than using one fixed axis for every bone -- a single shared axis doesn't
// account for each finger chain's own small baked-in rest rotation, which
// made fingers bend sideways instead of into the palm.
const WORLD_PALM_NORMAL = new THREE.Vector3(0, 0, -1);

const FINGER_CHAINS: Record<Finger, [string, string, string, string]> = {
  thumb: ["Bone001", "Bone002", "Bone003", "Bone004"],
  index: ["Bone005", "Bone006", "Bone007", "Bone008"],
  middle: ["Bone009", "Bone010", "Bone011", "Bone012"],
  ring: ["Bone013", "Bone014", "Bone015", "Bone016"],
  pinky: ["Bone017", "Bone018", "Bone019", "Bone020"],
};

const FINGER_NOTE_COLOR: Record<Finger, THREE.Color> = {
  thumb: new THREE.Color(0xffaa50), // matches pianoGame page's FINGER_COLOR
  index: new THREE.Color(0x78c8ff),
  middle: new THREE.Color(0x82e6a0),
  ring: new THREE.Color(0xc896ff),
  pinky: new THREE.Color(0xa0a0ff),
};
const DEFAULT_COLOR = new THREE.Color(0xe8d9c8);

export interface HandTwin3DHandle {
  update: (curls: Partial<Record<Finger, number>>, highlightFinger: Finger | null) => void;
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

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(1, 1, 1);
    scene.add(dirLight);

    let disposed = false;
    let animId: number;
    let bonesByName: Map<string, THREE.Bone> | null = null;
    // each rotating bone's rest-pose local quaternion, captured once after
    // load so curl rotations are always applied relative to the bind pose
    // rather than accumulating onto whatever the last frame left behind
    let restQuats: Map<string, THREE.Quaternion> | null = null;
    // each rotating bone's own flexion axis, in that bone's local space,
    // derived once from bind-pose geometry (see computeFlexAxis)
    let flexAxes: Map<string, THREE.Vector3> | null = null;
    // per-vertex finger assignment (index into geometry's position
    // attribute -> Finger | null), built once after load from skin
    // weights, used to paint only the highlighted finger's vertices
    let vertexFinger: (Finger | null)[] | null = null;
    let colorAttr: THREE.BufferAttribute | null = null;
    let lastHighlight: Finger | null | undefined = undefined;

    const loader = new FBXLoader();
    loader.load(
      "/simplehand.fbx",
      (object) => {
        if (disposed) return;

        object.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const dist = Math.max(size.x, size.y, size.z) * 1.6;
        camera.position.set(center.x, center.y, center.z + dist);
        camera.lookAt(center);

        const bones = new Map<string, THREE.Bone>();
        const rests = new Map<string, THREE.Quaternion>();
        let skinnedMesh: THREE.SkinnedMesh | null = null;
        object.traverse((child) => {
          if ((child as THREE.Bone).isBone) {
            const bone = child as THREE.Bone;
            bones.set(bone.name, bone);
            rests.set(bone.name, bone.quaternion.clone());
          }
          if ((child as THREE.SkinnedMesh).isSkinnedMesh) {
            skinnedMesh = child as THREE.SkinnedMesh;
          }
        });
        bonesByName = bones;
        restQuats = rests;

        // derive each rotating bone's own flexion axis from bind-pose
        // geometry: cross the bone's own "toward child" direction with the
        // palm normal (both in world space), then convert into the bone's
        // local space. Doing this per-bone (instead of using one shared
        // axis for every bone) accounts for each finger chain's own small
        // baked-in rest rotation.
        const axes = new Map<string, THREE.Vector3>();
        for (const finger of Object.keys(FINGER_CHAINS) as Finger[]) {
          const chain = FINGER_CHAINS[finger];
          for (let i = 1; i < 4; i++) {
            const bone = bones.get(chain[i]);
            const child = bone?.children.find((c) => (c as THREE.Bone).isBone) as THREE.Bone | undefined;
            if (!bone) continue;

            const boneWorldPos = new THREE.Vector3();
            bone.getWorldPosition(boneWorldPos);
            const childWorldPos = new THREE.Vector3();
            (child ?? bone).getWorldPosition(childWorldPos);
            // last joint (tip) has no child bone; fall back to the previous
            // joint's own toward-child direction since it shares the chain
            const towardChild = child
              ? childWorldPos.clone().sub(boneWorldPos).normalize()
              : (() => {
                  const prevBone = bones.get(chain[i - 1]);
                  if (!prevBone) return new THREE.Vector3(0, 1, 0);
                  const prevWorldPos = new THREE.Vector3();
                  prevBone.getWorldPosition(prevWorldPos);
                  return boneWorldPos.clone().sub(prevWorldPos).normalize();
                })();

            const worldFlexAxis = new THREE.Vector3().crossVectors(WORLD_PALM_NORMAL, towardChild).normalize();

            const parent = bone.parent;
            const parentWorldQuat = new THREE.Quaternion();
            if (parent) parent.getWorldQuaternion(parentWorldQuat);
            const localAxis = worldFlexAxis.clone().applyQuaternion(parentWorldQuat.clone().invert()).normalize();
            axes.set(chain[i], localAxis);
          }
        }
        flexAxes = axes;

        if (skinnedMesh) {
          const mesh = skinnedMesh as THREE.SkinnedMesh;
          mesh.material = new THREE.MeshStandardMaterial({ color: DEFAULT_COLOR, vertexColors: true });

          // bone name (e.g. "Bone008") -> which finger it belongs to, so a
          // vertex's dominant skin bone can be mapped to a Finger
          const boneNameToFinger = new Map<string, Finger>();
          for (const finger of Object.keys(FINGER_CHAINS) as Finger[]) {
            for (const name of FINGER_CHAINS[finger]) boneNameToFinger.set(name, finger);
          }
          // skinIndex values are indices into the skeleton's bones array,
          // not bone names -- build that lookup too
          const skeleton = mesh.skeleton;
          const boneIndexToFinger = skeleton.bones.map((b) => boneNameToFinger.get(b.name) ?? null);

          const geometry = mesh.geometry;
          const skinIndexAttr = geometry.getAttribute("skinIndex");
          const skinWeightAttr = geometry.getAttribute("skinWeight");
          const vertexCount = geometry.getAttribute("position").count;

          const vf: (Finger | null)[] = new Array(vertexCount).fill(null);
          if (skinIndexAttr && skinWeightAttr) {
            for (let v = 0; v < vertexCount; v++) {
              let bestWeight = -1;
              let bestFinger: Finger | null = null;
              for (let k = 0; k < 4; k++) {
                const weight = skinWeightAttr.getComponent(v, k);
                if (weight > bestWeight) {
                  bestWeight = weight;
                  const boneIdx = skinIndexAttr.getComponent(v, k);
                  bestFinger = boneIndexToFinger[boneIdx] ?? null;
                }
              }
              vf[v] = bestFinger;
            }
          }
          vertexFinger = vf;

          const colors = new Float32Array(vertexCount * 3);
          for (let v = 0; v < vertexCount; v++) {
            colors[v * 3] = DEFAULT_COLOR.r;
            colors[v * 3 + 1] = DEFAULT_COLOR.g;
            colors[v * 3 + 2] = DEFAULT_COLOR.b;
          }
          colorAttr = new THREE.BufferAttribute(colors, 3);
          geometry.setAttribute("color", colorAttr);
        }

        scene.add(object);
      },
      undefined,
      (err) => {
        console.error("HandTwin3D: failed to load simplehand.fbx", err);
      }
    );

    const renderLoop = () => {
      renderer.render(scene, camera);
      animId = requestAnimationFrame(renderLoop);
    };
    renderLoop();

    handleRef.current = {
      update(curls: Partial<Record<Finger, number>>, highlightFinger: Finger | null) {
        if (!bonesByName || !restQuats || !flexAxes) return; // model not loaded yet

        if (vertexFinger && colorAttr && highlightFinger !== lastHighlight) {
          lastHighlight = highlightFinger;
          const highlightColor = highlightFinger ? FINGER_NOTE_COLOR[highlightFinger] : null;
          for (let v = 0; v < vertexFinger.length; v++) {
            const useHighlight = highlightColor !== null && vertexFinger[v] === highlightFinger;
            const c = useHighlight ? highlightColor : DEFAULT_COLOR;
            colorAttr.setXYZ(v, c.r, c.g, c.b);
          }
          colorAttr.needsUpdate = true;
        }

        for (const finger of Object.keys(FINGER_CHAINS) as Finger[]) {
          const boneNames = FINGER_CHAINS[finger];
          const curl = Math.min(1, Math.max(0, curls[finger] ?? 0));
          const bendPerJoint = curl * (MAX_CURL_RADIANS / 3);

          // bone[0] is the MCP-anchor base, left at rest; bones[1..3] (the
          // pip/dip/tip segments) each bend by the same amount, around that
          // bone's own flexion axis (computed once at load time, see above)
          for (let i = 1; i < 4; i++) {
            const name = boneNames[i];
            const bone = bonesByName.get(name);
            const rest = restQuats.get(name);
            const localAxis = flexAxes.get(name);
            if (!bone || !rest || !localAxis) continue;

            const bend = new THREE.Quaternion().setFromAxisAngle(localAxis, bendPerJoint);
            bone.quaternion.copy(rest).multiply(bend);
          }
        }

        renderer.render(scene, camera); // force an immediate repaint (rAF is throttled on hidden/background tabs in some environments)
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
