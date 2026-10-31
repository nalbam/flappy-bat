/* Flappy Bat shared rules: plain values and pure functions, no DOM or THREE. */

// Fixed simulation step. 120 Hz gives 30 and 60 Hz displays a whole number of
// ticks per frame and keeps any display within one tick (8.3 ms) of real time.
export const TICK_RATE = 120;
export const TICK = 1 / TICK_RATE;
// Frame time simulated at most per frame (12 ticks). Longer stalls are dropped
// so the game slows down instead of jumping the bat past what the player saw.
export const MAX_FRAME_SECONDS = 0.1;
// Absorbs float rounding when summed frame times land exactly on a tick boundary.
export const TICK_EPSILON = 1e-9;

export const GRAVITY = 10.4; // downward acceleration while running, units/s²
export const FLAP_VELOCITY = 5.1; // upward velocity set by every flap, the start flap included

export const BASE_SPEED = 7.2; // world scroll speed at the start of a run, units/s
export const SPEED_GAIN = 0.19; // speed added per second of run time
export const MAX_SPEED_BONUS = 6; // cap of the added speed, so the top speed is 13.2

export const BAT_X = 0;
export const BAT_START_Y = 2.2;
export const BAT_HALF_WIDTH = 0.43; // body and head extent along x after the model turns to face +x

// The run ends when the bat centre leaves this range.
export const CAVE_TOP = 5.5;
export const CAVE_BOTTOM = -0.8;

export function speedAt(runTime) {
  return BASE_SPEED + Math.min(runTime * SPEED_GAIN, MAX_SPEED_BONUS);
}

// Semi-implicit Euler: update the velocity first, then move with the new velocity.
export function integrateVertical(y, velocity, dt = TICK, gravity = GRAVITY) {
  const next = velocity - gravity * dt;
  return { y: y + next * dt, velocity: next };
}

export function isOutsideCave(y) {
  return y > CAVE_TOP || y < CAVE_BOTTOM;
}
