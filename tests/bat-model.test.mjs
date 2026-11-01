import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BEAT_SECONDS, createBatMotion, wingOutline, wingPose } from '../docs/bat-model.mjs';

const SAMPLES = 400; // phases per beat checked by the sweeps below
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (v) => Math.hypot(...v);
const angle = (a, b) => Math.acos(Math.min(1, Math.max(-1, dot(a, b) / length(a) / length(b))));
const joints = (w) => [w.shoulder, w.elbow, w.wrist, ...w.tips, ...w.notches, w.hip];
const phases = Array.from({ length: SAMPLES }, (_, i) => i / SAMPLES);

// Opening of the finger fan at the wrist (first to last finger), and how far the fingertips
// reach out from the body axis (z in the wing frame).
const fan = (w) => angle(sub(w.tips[0], w.wrist), sub(w.tips[3], w.wrist));
const reach = (w) => Math.max(...w.tips.map(([x, y]) => Math.hypot(x, y)));
// Fingers measured against the forearm: a whole-wing turn keeps these angles, a fold changes them.
const fingersOnForearm = (w) => w.tips.map((t) => angle(sub(w.wrist, w.elbow), sub(t, w.wrist)));
// Normals of the membrane triangles the renderer draws: a fan around the wrist over wingOutline().
function membraneNormals(w) {
  const ring = wingOutline(w);
  return ring.slice(1).map((p, i) => cross(sub(ring[i], w.wrist), sub(p, w.wrist)));
}
const maxMove = (a, b) => Math.max(...joints(a).map((p, i) => length(sub(p, joints(b)[i]))));

// The beat as the renderer plays it: wrist height in the wing frame tells down- and upstroke.
const strokes = phases.map((p) => {
  const w = wingPose(p), next = wingPose(p + 1 / SAMPLES);
  return { w, down: next.wrist[1] < w.wrist[1] };
});

test('every wing pose is finite and the beat closes on itself', () => {
  for (const p of [...phases, 1]) {
    for (const crash of [0, 0.5, 1]) {
      assert.ok(joints(wingPose(p, crash)).flat().every(Number.isFinite), `phase ${p}, crash ${crash}`);
    }
  }
  assert.ok(maxMove(wingPose(0), wingPose(1)) < 1e-12, 'phase 1 is phase 0');
  assert.ok(maxMove(wingPose(0.999999), wingPose(0)) < 1e-4, 'no jump across the beat boundary');
  for (let i = 0; i < SAMPLES; i++) {
    assert.ok(maxMove(wingPose(i / SAMPLES), wingPose((i + 1) / SAMPLES)) < 0.06, `no joint jumps at phase ${i / SAMPLES}`);
  }
});

test('the wing opens on the downstroke and folds at the wrist and fingers on the upstroke', () => {
  const down = strokes.filter((s) => s.down).map((s) => s.w), up = strokes.filter((s) => !s.down).map((s) => s.w);
  assert.ok(down.length > SAMPLES * 0.3 && up.length > SAMPLES * 0.3, 'both strokes take a real part of the beat');
  const widest = down.reduce((a, b) => (fan(b) > fan(a) ? b : a));
  const tightest = up.reduce((a, b) => (fan(b) < fan(a) ? b : a));
  assert.ok(fan(widest) > 1.3 && fan(tightest) < 0.5 * fan(widest), `fan ${fan(widest)} opens and ${fan(tightest)} closes`);
  assert.ok(reach(tightest) < 0.6 * reach(widest), 'the folded wing reaches clearly less far out');
  assert.ok(Math.hypot(...tightest.wrist.slice(0, 2)) < 0.8 * Math.hypot(...widest.wrist.slice(0, 2)), 'the wrist comes in');
  // Not a rigid turn of the wing: the fingers move against the forearm, and the elbow bends.
  const open = fingersOnForearm(widest), shut = fingersOnForearm(tightest);
  assert.ok(Math.abs((open[3] - open[0]) - (shut[3] - shut[0])) > 0.5, 'the fingers spread apart from the forearm and close again');
  const elbow = (w) => angle(sub(w.elbow, w.shoulder), sub(w.wrist, w.elbow));
  assert.ok(elbow(tightest) - elbow(widest) > 0.3, 'the elbow bends to pull the wrist in');
  const mean = (list) => list.reduce((s, w) => s + fan(w), 0) / list.length;
  assert.ok(mean(down) > mean(up) + 0.3, 'the downstroke is the open half of the beat');
});

test('the membrane edge curves in between the fingers and the sheet never folds over', () => {
  for (const crash of [0, 0.3, 0.7, 1]) {
    let previous = null;
    for (const p of phases) {
      const w = wingPose(p, crash);
      w.notches.forEach((n, i) => {
        const next = w.tips[i + 1] ?? w.hip;
        const middle = w.tips[i].map((v, k) => (v + next[k]) / 2);
        assert.ok(length(sub(n, w.wrist)) < length(sub(middle, w.wrist)) - 0.02, `edge ${i} is concave at phase ${p}`);
      });
      const normals = membraneNormals(w);
      normals.forEach((n, i) => {
        assert.ok(length(n) > 1e-4, `triangle ${i} has area at phase ${p}`);
        assert.ok(dot(n, normals[0]) > 0, `triangle ${i} faces the same side as the first at phase ${p}`);
        if (previous) assert.ok(dot(n, previous[i]) > 0, `triangle ${i} does not flip between phases at ${p}`);
      });
      previous = normals;
    }
  }
});

test('membrane and bones meet at the same joints', () => {
  for (const p of [0, 0.25, 0.5, 0.75]) {
    const w = wingPose(p), ring = wingOutline(w);
    for (const joint of [w.shoulder, w.elbow, ...w.tips]) assert.ok(ring.includes(joint), 'bone end on the membrane outline');
    assert.ok(ring.includes(w.hip), 'the membrane reaches the hind leg');
  }
});

// Steps a motion through `seconds` in equal frames of about `dt`.
function play(motion, seconds, dt, state = 'running', tilt = 0) {
  const frames = Math.max(1, Math.round(seconds / dt));
  let pose = null;
  for (let i = 0; i < frames; i++) pose = motion.step(seconds / frames, state, tilt);
  return pose;
}

test('the pose follows elapsed time, not the frame rate', () => {
  for (const [state, seconds] of [['ready', 1], ['running', 0.5]]) {
    const at30 = play(createBatMotion(), seconds, 1 / 30, state, 0.2);
    const at144 = play(createBatMotion(), seconds, 1 / 144, state, 0.2);
    assert.ok(maxMove(at30.wing, at144.wing) < 1e-9, `${state} wings`);
    assert.ok(Math.abs(at30.head - at144.head) < 1e-9 && Math.abs(at30.wingRoot - at144.wingRoot) < 1e-9, `${state} follow-through`);
  }
  for (const state of ['ready', 'running']) {
    const motion = createBatMotion();
    const first = play(motion, 0.37, 1 / 60, state), later = play(motion, BEAT_SECONDS[state], 1 / 600, state);
    assert.ok(maxMove(first.wing, later.wing) < 1e-6, `${state} repeats after one beat`);
  }
});

test('after a flap the pose still follows elapsed time, not how frames split it', () => {
  // Each flap starts the quicker beat; the same time after it is played at 30 Hz, 144 Hz and with a
  // long frame, so each run passes the end of the quicker beat at a different frame split.
  const splits = [(m, s) => play(m, s, 1 / 30), (m, s) => play(m, s, 1 / 144),
    (m, s) => { m.step(0.01, 'running', 0); m.step(0.09, 'running', 0); return play(m, s - 0.1, 1 / 60); }];
  for (const before of [0.06, 0.12, 0.2, 0.26]) {
    for (const after of [0.15, 0.4, 1]) {
      const [first, ...others] = splits.map((split) => {
        const motion = createBatMotion();
        play(motion, before, 1 / 60);
        motion.flap();
        return split(motion, after);
      });
      for (const other of others) assert.ok(maxMove(first.wing, other.wing) < 1e-9, `flap ${before}s into the beat, ${after}s later`);
    }
  }
});

test('a flap starts the downstroke soon without a jump in the pose', () => {
  const MS = 0.00025; // fine steps, so a jump would show as a large move between two of them
  for (const before of [0.03, 0.06, 0.1, 0.16, 0.22, 0.28]) {
    const motion = createBatMotion();
    let last = play(motion, before, MS);
    motion.flap();
    assert.ok(maxMove(motion.step(0, 'running', 0).wing, last.wing) < 1e-12, 'the flap itself moves nothing');
    let downAt = null;
    for (let i = 1; i * MS <= 0.3 && downAt === null; i++) {
      const pose = motion.step(MS, 'running', 0);
      assert.ok(maxMove(pose.wing, last.wing) < 0.06, `the faster beat stays continuous at ${i * MS}s`);
      if (pose.wing.wrist[1] < last.wing.wrist[1]) downAt = i * MS;
      last = pose;
    }
    assert.ok(downAt !== null && downAt <= 0.14, `downstroke ${downAt}s after a flap ${before}s into the beat`);
  }
});

test('head and wing roots trail a quick change of body tilt, then settle', () => {
  const motion = createBatMotion();
  play(motion, 0.5, 1 / 60, 'running', -0.2);
  const jump = motion.step(1 / 60, 'running', 0.25); // a flap turns the body nose up at once
  assert.ok(jump.head < -0.05 && jump.wingRoot < -0.05, 'they stay behind the turn');
  assert.ok(Math.abs(jump.head) <= 0.3 && Math.abs(jump.wingRoot) <= 0.4, 'and stay small');
  const settled = play(motion, 1, 1 / 60, 'running', 0.25);
  assert.ok(Math.abs(settled.head) < 1e-3 && Math.abs(settled.wingRoot) < 1e-3, 'a steady tilt leaves no offset');
});

test('a crash keeps the touching pose, then folds the wings and stops the beat', () => {
  const motion = createBatMotion();
  const flying = play(motion, 0.41, 1 / 60, 'running', -0.3);
  const contact = motion.step(0, 'over', -0.3); // the crash frame is drawn with no time passed
  assert.ok(maxMove(contact.wing, flying.wing) < 1e-12, 'first over frame shows the touching pose');
  const folded = play(motion, 1, 1 / 60, 'over', 0.1);
  const still = play(motion, 0.3, 1 / 60, 'over', 0.1);
  assert.ok(maxMove(folded.wing, still.wing) < 1e-12, 'no beat after the fold');
  assert.ok(reach(folded.wing) < 0.6 * reach(wingPose(0.22)) && fan(folded.wing) < 0.6, 'wings folded');
});

test('reset() gives a new run the same start as a new bat', () => {
  const used = createBatMotion();
  play(used, 0.7, 1 / 60, 'running', 0.3); used.flap(); play(used, 0.6, 1 / 60, 'over', -0.4);
  used.reset();
  const fresh = createBatMotion();
  for (const state of ['ready', 'running']) {
    const a = used.step(1 / 60, state, 0), b = fresh.step(1 / 60, state, 0);
    assert.ok(maxMove(a.wing, b.wing) < 1e-12 && a.head === b.head && a.wingRoot === b.wingRoot, state);
  }
});
