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

// The body mesh: an icosahedron of this radius, scaled per model axis (x, y, z), then
// turned about y so the model, built facing -z, faces +x. Model z becomes world x and
// model x becomes depth, so the play plane (z = 0) sees an ellipse. Head, ears and wings
// are drawn around the body but are not part of it.
export const BAT_BODY_RADIUS = 0.43;
export const BAT_BODY_SCALE = Object.freeze([0.82, 1.2, 1]);
export const BAT_MODEL_YAW = -Math.PI / 2;
// Semi-axes of that ellipse on the play plane while the body is upright: 0.43 and 0.516.
export const BAT_HALF_WIDTH = BAT_BODY_RADIUS * Math.hypot(
  BAT_BODY_SCALE[0] * Math.cos(BAT_MODEL_YAW), BAT_BODY_SCALE[2] * Math.sin(BAT_MODEL_YAW));
export const BAT_HALF_HEIGHT = BAT_BODY_RADIUS * BAT_BODY_SCALE[1];

// The body tilts nose-up while rising and nose-down while falling. The renderer draws
// this tilt and collision tests the ellipse at the same tilt, so both always agree.
export const BAT_PITCH_PER_VELOCITY = 0.045; // radians per unit/s of vertical velocity
export const BAT_PITCH_RANGE = Object.freeze([-0.34, 0.32]);

// Cave surfaces on the play plane. The run ends when the body touches one; an upright
// body touches them with its centre at -0.804 and 5.504.
export const CAVE_FLOOR = -1.32;
export const CAVE_CEILING = 6.02;

export function speedAt(runTime) {
  return BASE_SPEED + Math.min(runTime * SPEED_GAIN, MAX_SPEED_BONUS);
}

// Semi-implicit Euler: update the velocity first, then move with the new velocity.
export function integrateVertical(y, velocity, dt = TICK, gravity = GRAVITY) {
  const next = velocity - gravity * dt;
  return { y: y + next * dt, velocity: next };
}

// Body tilt in radians (counter-clockwise, nose up) for a vertical velocity.
export function bodyPitch(velocity) {
  const [min, max] = BAT_PITCH_RANGE;
  return Math.min(max, Math.max(min, velocity * BAT_PITCH_PER_VELOCITY));
}
