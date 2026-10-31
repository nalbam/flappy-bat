/* Flappy Bat game model: state, bat, score and obstacles on a fixed tick, no DOM or THREE. */
import {
  BAT_START_Y, BAT_X, FLAP_VELOCITY, MAX_FRAME_SECONDS, TICK, TICK_EPSILON,
  bodyPitch, integrateVertical, speedAt,
} from './game-rules.mjs';
import { bodyExtents, sweepBody } from './collision.mjs';
import { OBSTACLE_HALF_WIDTH, createObstacleGenerator, randomSeed } from './obstacle-generator.mjs';

export const OBSTACLE_COUNT = 9;
// An obstacle left of this moves behind the farthest one, at the next generated spacing.
export const OBSTACLE_RECYCLE_X = -16;

// True when the whole bat body, at its current tilt, is past the obstacle's back face (its +x side).
export function hasCleared(bat, obstacle) {
  return obstacle.x + obstacle.halfWidth <= bat.x - bodyExtents(bodyPitch(bat.velocity)).halfWidth;
}

/**
 * Creates the game model. `seed` picks the obstacle layout of each run: a number gives every
 * run the same layout, a function is called by every reset() for the seed of the new run.
 * The default draws a fresh seed per run from the platform's cryptographic random source.
 *
 * - `state` is 'ready', 'running' or 'over'. Only 'running' advances.
 * - `seed` is the seed of the current run; createObstacleGenerator(seed) repeats its obstacles.
 * - `obstacles` holds OBSTACLE_COUNT descriptors `{ index, x, gapY, gapHeight, halfWidth, passed }`,
 *   `index` being the order in which the run's generator made them. The array and its objects
 *   keep their identity, so a renderer can map index to mesh.
 * - `distance` is how far the world scrolled in this run; `tick` counts simulated ticks.
 * - `crash` is null until the run ends, then `{ x, y, solid }`: the touched point of the floor,
 *   the ceiling or a pillar. The bat and the obstacles stay where the body touched it.
 */
export function createGame({ seed = randomSeed } = {}) {
  const nextSeed = typeof seed === 'function' ? seed : () => seed;
  let generator = null; // the current run's obstacle stream; it keeps no history of its own
  // Copies the next generated obstacle into `o`: at its start position in a new run, or
  // `after` (the farthest obstacle) plus the generated spacing when an obstacle is reused.
  const place = (o, after) => {
    const d = generator.next();
    o.index = d.index;
    o.x = after ? after.x + d.spacing : d.x;
    o.gapY = d.gapY;
    o.gapHeight = d.gapHeight;
    o.passed = false;
  };
  const game = {
    state: 'ready',
    seed: 0,
    bat: { x: BAT_X, y: BAT_START_Y, velocity: 0 },
    score: 0,
    runTime: 0,
    distance: 0,
    tick: 0,
    accumulator: 0, // frame time not yet consumed by a tick
    crash: null,
    obstacles: Array.from({ length: OBSTACLE_COUNT }, () => ({
      index: 0, x: 0, gapY: 0, gapHeight: 0, halfWidth: OBSTACLE_HALF_WIDTH, passed: false,
    })),

    // Back to 'ready' with the obstacle row of a new run seed; the bat waits at the start position.
    reset() {
      const runGenerator = createObstacleGenerator(nextSeed()); // an invalid seed throws before anything changes
      game.state = 'ready';
      game.bat.x = BAT_X;
      game.bat.y = BAT_START_Y;
      game.bat.velocity = 0;
      game.score = 0;
      game.runTime = 0;
      game.distance = 0;
      game.tick = 0;
      game.accumulator = 0;
      game.crash = null;
      game.seed = runGenerator.seed;
      generator = runGenerator;
      game.obstacles.forEach((o) => place(o, null));
    },

    // Sets the upward velocity once. In 'ready' it also starts the run, so the
    // start input and a normal flap give the same impulse. Returns false in 'over'.
    flap() {
      if (game.state === 'over') return false;
      game.state = 'running';
      game.bat.velocity = FLAP_VELOCITY;
      return true;
    },

    // One fixed tick. The body sweeps its whole move against the obstacles before anything
    // moves. On a contact the bat and the world stop at the touching position and the run
    // ends before scoring, so the tick that ends a run never adds points.
    step() {
      if (game.state !== 'running') return;
      const bat = game.bat;
      const next = integrateVertical(bat.y, bat.velocity, TICK);
      const dx = speedAt(game.runTime) * TICK;
      const dy = next.y - bat.y;
      const contact = sweepBody({ x: bat.x, y: bat.y }, { x: dx, y: dy }, bodyPitch(next.velocity), game.obstacles);
      const moved = contact ? dx * contact.time : dx;
      bat.y = contact ? bat.y + dy * contact.time : next.y;
      bat.velocity = next.velocity;
      game.runTime += TICK;
      game.distance += moved;
      game.tick += 1;
      for (const o of game.obstacles) o.x -= moved;
      if (contact) {
        game.state = 'over';
        game.crash = { x: contact.x - moved, y: contact.y, solid: contact.solid };
        return;
      }
      for (const o of game.obstacles) {
        if (o.x < OBSTACLE_RECYCLE_X) {
          place(o, game.obstacles.reduce((far, other) => (other.x > far.x ? other : far)));
        }
      }
      for (const o of game.obstacles) {
        if (!o.passed && hasCleared(bat, o)) {
          o.passed = true;
          game.score += 1;
        }
      }
    },

    // Consumes frame time in whole ticks and returns how many ran. A frame adds at
    // most MAX_FRAME_SECONDS; the rest is dropped. Outside 'running' the time is
    // discarded and nothing is banked. A frame that spans the start of a run still
    // holds time from before it; startRun() restarts the frame clock to remove it.
    advance(seconds) {
      if (game.state !== 'running') {
        game.accumulator = 0;
        return 0;
      }
      game.accumulator += seconds > 0 ? Math.min(seconds, MAX_FRAME_SECONDS) : 0;
      let ticks = 0;
      while (game.state === 'running' && game.accumulator >= TICK - TICK_EPSILON) {
        game.accumulator -= TICK;
        game.step();
        ticks += 1;
      }
      if (game.state !== 'running') game.accumulator = 0;
      return ticks;
    },
  };
  game.reset();
  return game;
}

/**
 * Turns requestAnimationFrame timestamps (ms) into frame seconds. The first frame
 * and the first frame after reset() return 0, so time while the tab was hidden is
 * never simulated. Results are clamped to [0, MAX_FRAME_SECONDS].
 */
export function createFrameClock() {
  let last = null;
  return {
    frame(now) {
      const seconds = last === null ? 0 : (now - last) / 1000;
      last = now;
      return seconds > 0 ? Math.min(seconds, MAX_FRAME_SECONDS) : 0;
    },
    reset() {
      last = null;
    },
  };
}

/**
 * Starts a run from 'ready' with the start flap and returns true; in other states it
 * does nothing and returns false. The clock restarts, so the frame after the start
 * returns 0 and the run never simulates time spent in 'ready' or 'over' before it.
 */
export function startRun(game, clock) {
  if (game.state !== 'ready') return false;
  game.flap();
  clock.reset();
  return true;
}
