/* Flappy Bat sound events: turns accepted model actions and tick results into sound effects. */
import { startRun } from './game-core.mjs';

/** Seconds between the chimes of several points scored in one frame, so each one is heard. */
export const SCORE_SPACING = 0.07;

/** startRun() with the flap sound of the start flap. Returns what startRun() returns. */
export function startWithSound(game, clock, sound) {
  if (!startRun(game, clock)) return false;
  sound.play('flap');
  return true;
}

/** game.flap() with one flap sound when the model accepts it. Returns what game.flap() returns. */
export function flapWithSound(game, sound) {
  if (!game.flap()) return false;
  sound.play('flap');
  return true;
}

/**
 * game.advance() with one score sound per point added in this frame and one crash sound when
 * the frame ends a running flight. Points scored before the crash tick of the same frame still
 * sound. Returns `{ ticks, scored, crashed }`. Only the advance itself changes the score here,
 * so a reset to 0 or a redrawn HUD never makes a sound.
 */
export function advanceWithSounds(game, seconds, sound) {
  const wasRunning = game.state === 'running';
  const scoreBefore = game.score;
  const ticks = game.advance(seconds);
  const scored = Math.max(0, game.score - scoreBefore);
  const crashed = wasRunning && game.state === 'over';
  for (let i = 0; i < scored; i++) sound.play('score', i * SCORE_SPACING);
  if (crashed) sound.play('crash');
  return { ticks, scored, crashed };
}
