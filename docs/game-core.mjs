/* Flappy Bat game model: state, bat, score and obstacles on a fixed tick, no DOM or THREE. */
import {
  BAT_HALF_WIDTH, BAT_START_Y, BAT_X, FLAP_VELOCITY, MAX_FRAME_SECONDS, TICK, TICK_EPSILON,
  integrateVertical, isOutsideCave, speedAt,
} from './game-rules.mjs';

export const OBSTACLE_COUNT = 9;
export const OBSTACLE_SPACING = 19;
export const FIRST_OBSTACLE_X = 24;
export const OBSTACLE_RECYCLE_X = -16; // an obstacle left of this moves to the back of the row
export const OBSTACLE_GAP_HEIGHT = 3.2; // opening between the inner ends of the two pillars
export const OBSTACLE_HALF_WIDTH = 0.62; // narrowest pillar radius
export const START_GAP_RANGE = [-0.7, 1.8]; // gapY range when a run is set up
export const RESPAWN_GAP_RANGE = [-0.4, 1.8]; // gapY range for a recycled obstacle
// The original hit test let the bat centre move 1.55 from the gap centre (gap half
// height 1.6 minus 0.05). hitsObstacle keeps that until body collision replaces it.
export const LEGACY_GAP_INSET = 0.05;

// Pure hit test: the bat overlaps the obstacle along x and is outside its gap.
export function hitsObstacle(bat, obstacle) {
  return Math.abs(obstacle.x - bat.x) < obstacle.halfWidth + BAT_HALF_WIDTH
    && Math.abs(bat.y - obstacle.gapY) > obstacle.gapHeight / 2 - LEGACY_GAP_INSET;
}

// True when the whole bat body is past the obstacle's back face (its +x side).
export function hasCleared(bat, obstacle) {
  return obstacle.x + obstacle.halfWidth <= bat.x - BAT_HALF_WIDTH;
}

/**
 * Creates the game model. `random` returns numbers in [0, 1) and picks gap heights.
 *
 * - `state` is 'ready', 'running' or 'over'. Only 'running' advances.
 * - `obstacles` holds OBSTACLE_COUNT descriptors `{ x, gapY, gapHeight, halfWidth, passed }`.
 *   The array and its objects keep their identity, so a renderer can map index to mesh.
 * - `distance` is how far the world scrolled in this run; `tick` counts simulated ticks.
 */
export function createGame({ random = Math.random } = {}) {
  const randomIn = ([min, max]) => min + random() * (max - min);
  const game = {
    state: 'ready',
    bat: { x: BAT_X, y: BAT_START_Y, velocity: 0 },
    score: 0,
    runTime: 0,
    distance: 0,
    tick: 0,
    accumulator: 0, // frame time not yet consumed by a tick
    obstacles: Array.from({ length: OBSTACLE_COUNT }, () => ({
      x: 0, gapY: 0, gapHeight: OBSTACLE_GAP_HEIGHT, halfWidth: OBSTACLE_HALF_WIDTH, passed: false,
    })),

    // Back to 'ready' with a new obstacle row; the bat waits at the start position.
    reset() {
      game.state = 'ready';
      game.bat.x = BAT_X;
      game.bat.y = BAT_START_Y;
      game.bat.velocity = 0;
      game.score = 0;
      game.runTime = 0;
      game.distance = 0;
      game.tick = 0;
      game.accumulator = 0;
      game.obstacles.forEach((o, i) => {
        o.x = FIRST_OBSTACLE_X + i * OBSTACLE_SPACING;
        o.gapY = randomIn(START_GAP_RANGE);
        o.passed = false;
      });
    },

    // Sets the upward velocity once. In 'ready' it also starts the run, so the
    // start input and a normal flap give the same impulse. Returns false in 'over'.
    flap() {
      if (game.state === 'over') return false;
      game.state = 'running';
      game.bat.velocity = FLAP_VELOCITY;
      return true;
    },

    // One fixed tick: move the bat and the world, then judge. A crash ends the
    // tick before scoring, so the tick that ends a run never adds points.
    step() {
      if (game.state !== 'running') return;
      const bat = game.bat;
      const next = integrateVertical(bat.y, bat.velocity, TICK);
      bat.y = next.y;
      bat.velocity = next.velocity;
      const dx = speedAt(game.runTime) * TICK;
      game.runTime += TICK;
      game.distance += dx;
      game.tick += 1;
      for (const o of game.obstacles) {
        o.x -= dx;
        if (o.x < OBSTACLE_RECYCLE_X) {
          o.x += OBSTACLE_COUNT * OBSTACLE_SPACING;
          o.gapY = randomIn(RESPAWN_GAP_RANGE);
          o.passed = false;
        }
      }
      if (isOutsideCave(bat.y) || game.obstacles.some((o) => hitsObstacle(bat, o))) {
        game.state = 'over';
        return;
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
