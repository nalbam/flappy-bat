/* Flappy Bat character: the bat mesh for Three.js and its wingbeat pose. The pose code uses
   no THREE or DOM, so tests import it directly; makeBat() gets THREE from the page. */
import { BAT_BODY_RADIUS, BAT_BODY_SCALE, BAT_MODEL_YAW, BAT_START_Y, BAT_X } from './game-rules.mjs';

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Seconds per wingbeat: a calm hover on the start screen, a quicker beat in flight. A flap
// finishes the current beat within RUSH_SECONDS, so the downstroke starts with the input
// instead of up to one beat later.
export const BEAT_SECONDS = Object.freeze({ ready: 0.5, running: 0.3 });
const RUSH_SECONDS = 0.12;
const DOWNSTROKE_START = 0.15; // a flap during the first part of the downstroke keeps the beat
const FOLD_SECONDS = 0.35; // after a crash the wings fold over this time
const FOLLOW_SECONDS = 0.1; // head and wing roots trail the drawn body tilt by about this time

// Wing chain in its own plane: [angle from straight out toward the tail (rad), length].
// The arm is shoulder→elbow→wrist; the four fingers fan out from the wrist.
const SPREAD = { upper: [-0.2, 0.3], fore: [0.16, 0.56], digits: [[0.04, 0.86], [0.44, 0.94], [0.9, 0.78], [1.42, 0.6]] };
const FOLDED = { upper: [0.3, 0.3], fore: [1.05, 0.56], digits: [[1.25, 0.58], [1.36, 0.62], [1.5, 0.54], [1.68, 0.44]] };
const HIP = [0.03, -0.24, 0.4]; // where the membrane meets the hind leg, from the shoulder
const NOTCH = 0.3; // depth of the trailing-edge curve between two tips, per unit of their gap
const STROKE = { mid: 0.4, amplitude: 0.75, hand: 0.42, handDelay: 0.6, spreadPeak: 1.4 };
const CRASH = { elevation: 0.55, hand: -0.7 }; // folded wings after a crash

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
// Moves `length` along a planar `angle` from point o, with the plane lifted by `elevation` about
// the body axis (z). x points out from the body, y up and z toward the tail.
function reach(o, [angle, length], elevation) {
  const out = Math.cos(angle) * length;
  return add(o, [out * Math.cos(elevation), out * Math.sin(elevation), Math.sin(angle) * length]);
}
// Point between two tips pulled toward the wrist, so the membrane edge curves inward there.
function notch(a, b, wrist) {
  const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const d = [wrist[0] - m[0], wrist[1] - m[1], wrist[2] - m[2]];
  const k = NOTCH * Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / Math.hypot(...d);
  return add(m, [d[0] * k, d[1] * k, d[2] * k]);
}
const blend = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];

/**
 * Joint positions of one wing at a beat phase, in the wing frame (shoulder at the origin,
 * x out from the body, y up, z toward the tail). Phase 0 is the top of the stroke; the wing
 * opens as it beats down and folds at the wrist and fingers as it recovers up. `crash` (0..1)
 * blends to the folded crash pose. Bones and membrane are both drawn from these points.
 * @returns {{shoulder: number[], elbow: number[], wrist: number[], tips: number[][], notches: number[][], hip: number[]}}
 */
export function wingPose(phase, crash = 0) {
  const a = TAU * phase;
  const open = 0.5 + 0.5 * Math.cos(a - STROKE.spreadPeak);
  const spread = lerp(open * open * (3 - 2 * open), 0, crash); // held open and held folded, quick between
  const elevation = lerp(STROKE.mid + STROKE.amplitude * Math.cos(a), CRASH.elevation, crash);
  const hand = elevation + lerp(STROKE.hand * Math.sin(a - STROKE.handDelay), CRASH.hand, crash); // the hand trails the arm
  const shoulder = [0, 0, 0];
  const elbow = reach(shoulder, blend(FOLDED.upper, SPREAD.upper, spread), elevation);
  const wrist = reach(elbow, blend(FOLDED.fore, SPREAD.fore, spread), elevation);
  const tips = SPREAD.digits.map((d, i) => reach(wrist, blend(FOLDED.digits[i], d, spread), hand));
  const hip = HIP.slice();
  const notches = tips.map((t, i) => notch(t, tips[i + 1] ?? hip, wrist)); // the last curve runs to the hip
  return { shoulder, elbow, wrist, tips, notches, hip };
}

/** Membrane outline around the wrist, from the leading fingertip back to the elbow. */
export function wingOutline(w) {
  return [...w.tips.flatMap((t, i) => [t, w.notches[i]]), w.hip, w.shoulder, w.elbow];
}

/**
 * Time-based animation state. step() advances by frame seconds and returns the pose for the
 * game state and the drawn body tilt (rad); flap() starts a downstroke; reset() is a new run.
 */
export function createBatMotion() {
  let phase, rush, crash, follow;
  const motion = {
    reset() { phase = 0; rush = false; crash = 0; follow = 0; },
    flap() { if (phase > DOWNSTROKE_START) rush = true; },
    step(dt, state, tilt) {
      if (state === 'over') crash = Math.min(1, crash + dt / FOLD_SECONDS);
      else {
        crash = 0;
        const beat = state === 'ready' ? BEAT_SECONDS.ready : BEAT_SECONDS.running;
        phase += dt / (rush ? RUSH_SECONDS : beat);
        if (phase >= 1) { phase %= 1; rush = false; }
      }
      follow += (tilt - follow) * (1 - Math.exp(-dt / FOLLOW_SECONDS));
      const lagging = follow - tilt;
      const eased = crash * crash * (3 - 2 * crash);
      return { wing: wingPose(phase, eased), head: clamp(lagging * 0.7, -0.3, 0.3), wingRoot: clamp(lagging, -0.4, 0.4) };
    },
  };
  motion.reset();
  return motion;
}

// Palette from the cave and the UI: plum-brown fur darker than the lit rock, a dark rust membrane,
// and style.css --cream (eyes, fangs) and --rust (nose, inner ears) as the only bright accents.
const PALETTE = { fur: 0x140b11, membrane: 0x55252a, glow: 0x3a1210, inner: 0xd87554, eye: 0xf4eee1, pupil: 0x140b10 };
const HEAD_AT = [0, 0.16, -0.15];
const HEAD_TURN = -0.45; // face turned toward the camera (model +x), so both eyes and ears show from the side
const SHOULDER = [0.24, 0.12, 0.1]; // behind the head, so a raised near wing passes behind the ears
// Roll lifts the near wing above the far one, so the two never stack into one line on screen;
// yaw sweeps the far wing back, as perspective would otherwise draw it in front of the face.
const WING_TURN = { yaw: 0.15, roll: 0.5 };
const BONES = [['shoulder', 'elbow', 0.05], ['elbow', 'wrist', 0.04], ...[0, 1, 2, 3].map((i) => ['wrist', i, 0.024])]; // [from, to, radius]; numbers are fingers

/**
 * Builds the bat for a Three.js r128 namespace. Returns the group placed at the bat position,
 * the light it carries, and pose(), which applies a createBatMotion() pose without creating
 * geometry or materials. The body is the collision mesh of game-rules.mjs; the head, ears
 * and wings are drawn around it and do not collide.
 */
export function makeBat(THREE) {
  const standard = (color, extra) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, flatShading: true, ...extra });
  const fur = standard(PALETTE.fur), inner = standard(PALETTE.inner, { roughness: 0.6 });
  const skin = standard(PALETTE.membrane, { side: THREE.DoubleSide, emissive: PALETTE.glow, roughness: 0.9 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: PALETTE.eye }), pupilMat = new THREE.MeshBasicMaterial({ color: PALETTE.pupil });
  const add = (parent, geometry, material, [x, y, z] = [0, 0, 0]) => {
    const m = new THREE.Mesh(geometry, material); m.position.set(x, y, z); parent.add(m); return m;
  };
  const group = (parent, [x, y, z], rotation = [0, 0, 0], order = 'XYZ') => {
    const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.set(...rotation, order); parent.add(g); return g;
  };

  const bat = new THREE.Group(); bat.position.set(BAT_X, BAT_START_Y, 0);
  const root = group(bat, [0, 0, 0], [0, BAT_MODEL_YAW, 0]); // model faces -z; turn it to face +x
  const body = add(root, new THREE.IcosahedronGeometry(BAT_BODY_RADIUS, 1), fur); body.scale.set(...BAT_BODY_SCALE); body.castShadow = true;

  const head = group(root, HEAD_AT, [0, HEAD_TURN, 0]);
  add(head, new THREE.IcosahedronGeometry(0.24, 1), fur);
  add(head, new THREE.IcosahedronGeometry(0.11, 0), fur, [0, -0.06, -0.17]); // muzzle
  add(head, new THREE.SphereGeometry(0.04, 6, 4), inner, [0, -0.03, -0.28]); // nose
  const earGeo = new THREE.ConeGeometry(0.17, 0.62, 4).translate(0, 0.31, 0).scale(0.4, 1, 1);
  const innerEarGeo = new THREE.ConeGeometry(0.1, 0.44, 3).translate(0, 0.22, 0).scale(0.35, 1, 1);
  const eyeGeo = new THREE.IcosahedronGeometry(0.075, 1), pupilGeo = new THREE.IcosahedronGeometry(0.042, 1);
  const fangGeo = new THREE.ConeGeometry(0.018, 0.06, 3).rotateX(Math.PI), browGeo = new THREE.BoxGeometry(0.13, 0.04, 0.05);
  [-1, 1].forEach((s) => {
    const ear = group(head, [s * 0.13, 0.12, 0.04], [0.25, s * 0.35, -s * 0.3], 'YXZ'); // opening faces out and forward
    add(ear, earGeo, fur); add(ear, innerEarGeo, inner, [s * 0.035, 0.04, -0.01]);
    add(head, eyeGeo, eyeMat, [s * 0.1, 0.05, -0.18]); add(head, pupilGeo, pupilMat, [s * 0.112, 0.05, -0.235]);
    add(head, fangGeo, eyeMat, [s * 0.04, -0.1, -0.255]);
    add(head, browGeo, fur, [s * 0.1, 0.12, -0.215]).rotation.set(0, s * 0.3, s * 0.38); // lowered inner brow: a focused look
  });

  const roots = group(root, [0, SHOULDER[1], SHOULDER[2]]);
  const span = group(roots, [0, 0, 0], [0, WING_TURN.yaw, WING_TURN.roll], 'YXZ');
  const boneGeo = new THREE.CylinderGeometry(0.7, 1, 1, 5).translate(0, 0.5, 0);
  const knuckleGeo = new THREE.IcosahedronGeometry(0.05, 0);
  const ring = wingOutline(wingPose(0)).length;
  const membrane = new THREE.BufferGeometry(); // one fan around the wrist, shared by both wings
  membrane.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * (ring + 1)), 3));
  membrane.setIndex(Array.from({ length: ring - 1 }, (_, i) => [0, i + 1, i + 2]).flat());
  const wings = [-1, 1].map((s) => {
    const g = group(span, [s * SHOULDER[0], 0, 0]); g.scale.x = s; // the far wing mirrors the near one
    add(g, membrane, skin).frustumCulled = false; // its vertices move every frame
    return { bones: BONES.map(() => add(g, boneGeo, fur)), knuckle: add(g, knuckleGeo, fur) };
  });
  const glow = new THREE.PointLight(0xd17c59, 1.8, 4.5, 2); glow.position.set(0, 0.2, 0.15); root.add(glow);

  const from = new THREE.Vector3(), to = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  function pose({ wing, head: headTilt, wingRoot }) {
    head.rotation.x = headTilt; roots.rotation.x = wingRoot;
    const position = membrane.attributes.position;
    [wing.wrist, ...wingOutline(wing)].forEach((p, i) => position.setXYZ(i, p[0], p[1], p[2]));
    position.needsUpdate = true;
    const point = (key) => (typeof key === 'number' ? wing.tips[key] : wing[key]);
    BONES.forEach(([a, b, radius], i) => {
      from.set(...point(a)); to.set(...point(b)).sub(from);
      const length = to.length(); to.divideScalar(length);
      wings.forEach(({ bones }) => { bones[i].position.copy(from); bones[i].quaternion.setFromUnitVectors(up, to); bones[i].scale.set(radius, length, radius); });
    });
    wings.forEach(({ knuckle }) => knuckle.position.set(...wing.wrist));
  }
  return { group: bat, glow, pose };
}
