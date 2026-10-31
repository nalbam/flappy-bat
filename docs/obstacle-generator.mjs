/* Flappy Bat obstacle generator: a seeded stream of pillar gaps placed around a planned safe
   flap path. Plain values and pure functions, no DOM or THREE. */
import {
  BAT_HALF_HEIGHT, BAT_PITCH_RANGE, BAT_START_Y, BAT_X, CAVE_CEILING, CAVE_FLOOR, FLAP_VELOCITY, GRAVITY,
  TICK, TICK_RATE, bodyPitch, integrateVertical, speedAt,
} from './game-rules.mjs';
import { bodyExtents } from './collision.mjs';
import { PLAY_VIEW } from './view.mjs';

export const OBSTACLE_HALF_WIDTH = 0.62; // half width of the pillar outline

// Time from the start input until the body can first touch the first pillar.
export const READY_SECONDS = 2.5;

// Difficulty grows linearly with the obstacle index (the score when the bat reaches it) from
// the `easy` ranges at index 0 to the `hard` ranges at DIFFICULTY_RAMP and stays there.
// Speed grows separately with run time (speedAt) and reaches its cap after about 32 s.
export const DIFFICULTY_RAMP = 20;
export const GAP_HEIGHT_RANGE = Object.freeze({ easy: [3.9, 4.3], hard: [3.3, 3.7] }); // gap edge to gap edge
export const SPACING_RANGE = Object.freeze({ easy: [16, 19], hard: [12.5, 15.5] }); // x from the previous pillar
export const TARGET_SHIFT = Object.freeze({ easy: 1.2, hard: 2.4 }); // largest change of the planned hover height

// Clearance between the planned path and every gap edge, the floor and the ceiling. At the
// 5.1 units/s a hovering bat falls with when it flaps, it allows a flap about 90 ms early or late.
export const SAFE_MARGIN = 0.45;
// Each pillar shows at least this much above the floor or below the ceiling, so a gap never
// opens onto the cave surface.
export const MIN_PILLAR_LENGTH = 0.5;
export const GAP_EDGE_RANGE = Object.freeze([CAVE_FLOOR + MIN_PILLAR_LENGTH, CAVE_CEILING - MIN_PILLAR_LENGTH]);
// The planned path flaps at most four times per second, a rate a player can tap.
export const MIN_FLAP_INTERVAL_TICKS = TICK_RATE / 4;
// The planned path heads for a new gap only this long after the pillar comes on screen: its
// centre within PLAY_VIEW.ahead of the bat, which every screen shows. So it uses no knowledge
// a player does not have.
export const REACTION_SECONDS = 0.25;
const REACTION_TICKS = Math.round(REACTION_SECONDS * TICK_RATE);

// Widest half width of the body at any tilt the game draws.
const BODY_MAX_HALF_WIDTH = Math.max(...BAT_PITCH_RANGE.map((pitch) => bodyExtents(pitch).halfWidth));
// Ticks within this x distance of a pillar count as passing it; covers float drift of positions.
const OVERLAP_PAD = 0.01;

// A hovering path flaps as soon as it drops below its target height, so it stays between
// HOVER_DIP below the target (one tick of the fastest fall in the cave) and HOVER_RISE above it.
const HOVER_RISE = FLAP_VELOCITY ** 2 / (2 * GRAVITY);
const HOVER_DIP = Math.sqrt(2 * GRAVITY * (CAVE_CEILING - CAVE_FLOOR)) * TICK + GRAVITY * TICK * TICK;
// Planned hover heights keep that whole range and the body within GAP_EDGE_RANGE by SAFE_MARGIN,
// so a gap with both pillars visible always fits around a hover.
export const TARGET_RANGE = Object.freeze([
  GAP_EDGE_RANGE[0] + SAFE_MARGIN + BAT_HALF_HEIGHT + HOVER_DIP,
  GAP_EDGE_RANGE[1] - SAFE_MARGIN - BAT_HALF_HEIGHT - HOVER_RISE,
]);

// Distance the world scrolls in the first `ticks` ticks of a run, summed as the game model does.
function scrolled(ticks) {
  let runTime = 0, distance = 0;
  for (let i = 0; i < ticks; i++) { distance += speedAt(runTime) * TICK; runTime += TICK; }
  return distance;
}

// The first pillar sits where the widest body reaches its near face exactly READY_SECONDS in.
export const FIRST_OBSTACLE_X = BAT_X + scrolled(Math.round(READY_SECONDS * TICK_RATE)) + BODY_MAX_HALF_WIDTH + OBSTACLE_HALF_WIDTH;

const lerp = ([a, b], t) => a + (b - a) * t;
const between = (easy, hard, p) => easy + (hard - easy) * p;

/**
 * Ranges for the obstacle with this index (0 is the first pillar of a run).
 * @returns {{progress: number, gapHeight: [number, number], spacing: [number, number], shift: number}}
 */
export function difficulty(index) {
  const p = Math.min(1, Math.max(0, index / DIFFICULTY_RAMP));
  return {
    progress: p,
    gapHeight: GAP_HEIGHT_RANGE.easy.map((v, i) => between(v, GAP_HEIGHT_RANGE.hard[i], p)),
    spacing: SPACING_RANGE.easy.map((v, i) => between(v, SPACING_RANGE.hard[i], p)),
    shift: between(TARGET_SHIFT.easy, TARGET_SHIFT.hard, p),
  };
}

/** Game random source: mulberry32 seeded with a 32-bit unsigned integer. Returns numbers in [0, 1). */
export function createRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MAX_SEED = 0xffffffff;
export const isSeed = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_SEED;

/** A new run seed from the platform's cryptographic source, so it never draws from Math.random. */
export function randomSeed() {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
}

/** Seed from text such as the `seed` URL parameter: a decimal integer 0..MAX_SEED, else null. */
export function parseSeed(text) {
  if (typeof text !== 'string' || !/^\d{1,10}$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return isSeed(value) ? value : null;
}

// One tick of the planned path, in the order of the game model's step(): flap input, vertical
// integration, then the world scrolls by the speed of the current run time. Returns the box the
// body sweeps in that tick, in world x (the bat's x plus the scrolled distance).
function stepPath(s, flaps) {
  if (s.y < s.target && s.tick - s.lastFlap >= MIN_FLAP_INTERVAL_TICKS) {
    s.velocity = FLAP_VELOCITY;
    s.lastFlap = s.tick;
    flaps.push(s.tick);
  }
  const next = integrateVertical(s.y, s.velocity, TICK);
  const dx = speedAt(s.runTime) * TICK;
  const ext = bodyExtents(bodyPitch(next.velocity));
  const x = BAT_X + s.distance;
  const box = {
    left: x - ext.halfWidth, right: x + dx + ext.halfWidth,
    low: Math.min(s.y, next.y) - ext.halfHeight, high: Math.max(s.y, next.y) + ext.halfHeight,
  };
  s.y = next.y;
  s.velocity = next.velocity;
  s.runTime += TICK;
  s.distance += dx;
  s.tick += 1;
  if (s.y >= s.target) s.reached = true;
  return box;
}

// True when the path is in a hover around its target: it has reached the target since the
// target was set, and its highest point before the next flap (the next flap comes only after
// it drops below the target) is within HOVER_RISE of it. From then on the path stays between
// HOVER_DIP below and HOVER_RISE above the target for as long as the target holds.
function hovering(s) {
  return s.reached && s.y + Math.max(0, s.velocity) ** 2 / (2 * GRAVITY) <= s.target + HOVER_RISE;
}

// Plans the path from `start` (the exit of the previous pillar) until the body is past the
// pillar at `x`. It keeps hovering at the start target and turns to `target` REACTION_TICKS after
// the pillar comes on screen. Returns null when the plan leaves the cave margin, its body range at
// the pillar does not fit a gap of `gapHeight` with both pillars visible, or, holding `target`
// after the exit, it does not hover before the next pillar (at least `nextSpacing` on) can be
// touched. Otherwise returns the exit state, the flap ticks and the range of gap bottoms that keep
// SAFE_MARGIN to the body.
function planSegment(start, target, x, gapHeight, nextSpacing) {
  const s = { ...start };
  const flaps = [];
  const insideCave = (box) => box.low >= CAVE_FLOOR + SAFE_MARGIN && box.high <= CAVE_CEILING - SAFE_MARGIN;
  let low = Infinity, high = -Infinity, seen = null;
  while (BAT_X + s.distance - BODY_MAX_HALF_WIDTH <= x + OBSTACLE_HALF_WIDTH + OVERLAP_PAD) {
    if (s.target !== target) {
      if (seen === null && x - (BAT_X + s.distance) <= PLAY_VIEW.ahead) seen = s.tick;
      if (seen !== null && s.tick >= seen + REACTION_TICKS) Object.assign(s, { target, reached: s.y >= target });
    }
    const box = stepPath(s, flaps);
    if (!insideCave(box)) return null;
    if (box.right >= x - OBSTACLE_HALF_WIDTH - OVERLAP_PAD && box.left <= x + OBSTACLE_HALF_WIDTH + OVERLAP_PAD) {
      low = Math.min(low, box.low);
      high = Math.max(high, box.high);
    }
  }
  if (s.target !== target) return null;
  const bottom = [Math.max(high + SAFE_MARGIN - gapHeight, GAP_EDGE_RANGE[0]), Math.min(low - SAFE_MARGIN, GAP_EDGE_RANGE[1] - gapHeight)];
  if (bottom[0] > bottom[1]) return null;
  // Holding the target, the path must hover before a tick that can reach the next pillar. Then
  // keeping this target for the next pillar fits its gap, so the next pillar always has a plan.
  const probe = { ...s };
  const nextNearFace = x + nextSpacing - OBSTACLE_HALF_WIDTH - OVERLAP_PAD;
  while (!hovering(probe)) {
    const reach = BAT_X + probe.distance + speedAt(probe.runTime) * TICK + BODY_MAX_HALF_WIDTH;
    if (reach >= nextNearFace || !insideCave(stepPath(probe, []))) return null;
  }
  return { state: s, flaps, low, high, bottom };
}

// Shares of the wanted hover change tried in turn. The last keeps the current hover height and
// always fits: the path hovers there before this pillar can be touched; while a hover passes a
// pillar (0.31 s at the start speed, the longest) the body spans at most about 2.2 in height, 3.1
// with SAFE_MARGIN on both sides, under the narrowest gap; and TARGET_RANGE keeps the whole hover
// inside GAP_EDGE_RANGE.
const SHIFT_STEPS = [1, 0.5, 0.25, 0];

/**
 * Creates the obstacle stream of one run. The same seed always gives the same descriptors.
 *
 * The generator first plans a flap path from the start input (tick 0, the bat at BAT_START_Y)
 * with the game's own tick physics, then puts each gap around the part of that path that
 * passes the pillar. Each path segment starts from the exact position, velocity and tick at
 * which the previous segment left its pillar, so the path is one connected run. The scroll
 * speed of every tick is the speed at that run time, so a pillar is passed at its arrival speed.
 *
 * @param {number} seed 32-bit unsigned integer.
 * @param {{difficultyAt?: typeof difficulty}} [options] `difficultyAt` replaces the difficulty ramp (tests).
 * @returns {{seed: number, next(): ObstacleDescriptor}}
 *
 * @typedef {object} ObstacleDescriptor
 * @property {number} index Order in the run, from 0.
 * @property {number} x World x of the pillar centre at the start of the run.
 * @property {number} spacing x distance from the previous pillar (from the bat for index 0).
 * @property {number} gapY Gap centre.
 * @property {number} gapHeight Gap edge to gap edge.
 * @property {{flaps: number[], low: number, high: number, exit: {tick: number, y: number, velocity: number}}} path
 *   The planned path: ticks with a flap input before the tick runs (tick 0 is the start input), the
 *   lowest and highest body point while passing this pillar, and the state when it leaves the pillar.
 */
export function createObstacleGenerator(seed, { difficultyAt = difficulty } = {}) {
  if (!isSeed(seed)) throw new RangeError(`seed must be an integer from 0 to ${MAX_SEED}: ${seed}`);
  const random = createRandom(seed);
  // The planned path at the exit of the latest pillar; only this state is kept between pillars.
  let path = {
    tick: 0, runTime: 0, distance: 0, y: BAT_START_Y, velocity: FLAP_VELOCITY, lastFlap: 0,
    target: BAT_START_Y, reached: true,
  };
  let index = 0, lastX = BAT_X;
  return {
    seed,
    next() {
      const range = difficultyAt(index), nextSpacing = difficultyAt(index + 1).spacing[0];
      // Every pillar draws the same four numbers, so retries never shift later pillars.
      const spacingDraw = random(), heightDraw = random(), shiftDraw = random(), placeDraw = random();
      const x = index === 0 ? FIRST_OBSTACLE_X : lastX + lerp(range.spacing, spacingDraw);
      const gapHeight = lerp(range.gapHeight, heightDraw);
      const wanted = lerp([Math.max(TARGET_RANGE[0], path.target - range.shift), Math.min(TARGET_RANGE[1], path.target + range.shift)], shiftDraw);
      let plan = null;
      for (const share of SHIFT_STEPS) {
        plan = planSegment(path, path.target + (wanted - path.target) * share, x, gapHeight, nextSpacing);
        if (plan) break;
      }
      if (!plan) throw new Error(`no safe path to obstacle ${index} of seed ${seed}`);
      const bottom = lerp(plan.bottom, placeDraw);
      const flaps = index === 0 ? [0, ...plan.flaps] : plan.flaps;
      const descriptor = {
        index, x, spacing: x - lastX, gapY: bottom + gapHeight / 2, gapHeight,
        path: { flaps, low: plan.low, high: plan.high, exit: { tick: plan.state.tick, y: plan.state.y, velocity: plan.state.velocity } },
      };
      path = plan.state;
      index += 1;
      lastX = x;
      return descriptor;
    },
  };
}
