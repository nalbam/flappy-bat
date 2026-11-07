import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceWithSounds, flapWithSound, startWithSound, SCORE_SPACING } from '../docs/audio-events.mjs';
import { createSound } from '../docs/audio.mjs';
import { BAT_HALF_HEIGHT, CAVE_FLOOR, MAX_FRAME_SECONDS, TICK } from '../docs/game-rules.mjs';
import { createFrameClock, createGame } from '../docs/game-core.mjs';
import { contextFactory, memoryStorage, soundLog } from './fake-audio.mjs';

// Moves every obstacle behind the bat except the ones given, which sit just behind it, unscored.
function scoreNext(game, count) {
  game.obstacles.forEach((o, i) => { o.x = 200 + i * 20; });
  for (let i = 0; i < count; i++) {
    const o = game.obstacles[i];
    o.x = game.bat.x - 3;
    o.gapY = game.bat.y;
    o.passed = false;
  }
}

test('the start and every accepted flap sound once; refused flaps are silent', () => {
  const game = createGame({ seed: 7 });
  const clock = createFrameClock();
  const sound = soundLog();
  assert.equal(startWithSound(game, clock, sound), true);
  assert.deepEqual(sound.played, ['flap'], 'the start flap sounds');
  assert.equal(startWithSound(game, clock, sound), false, 'a second start while running is refused');
  assert.equal(flapWithSound(game, sound), true);
  assert.equal(flapWithSound(game, sound), true);
  assert.deepEqual(sound.played, ['flap', 'flap', 'flap']);

  game.pause();
  assert.equal(flapWithSound(game, sound), false, 'paused refuses the flap');
  game.resume();
  game.bat.y = CAVE_FLOOR - 1;
  advanceWithSounds(game, TICK, sound);
  assert.equal(game.state, 'over');
  assert.equal(flapWithSound(game, sound), false, 'over refuses the flap');
  assert.equal(startWithSound(game, clock, sound), false, 'over refuses a start');
  assert.deepEqual(sound.played, ['flap', 'flap', 'flap', 'crash']);
});

test('each point sounds once, several points in one frame are spaced, and redraws add nothing', () => {
  const game = createGame({ seed: 7 });
  const sound = soundLog();
  startWithSound(game, createFrameClock(), sound);
  scoreNext(game, 2);
  const result = advanceWithSounds(game, TICK, sound);
  assert.equal(result.scored, 2);
  assert.equal(game.score, 2);
  assert.deepEqual(sound.played, ['flap', 'score', ['score', SCORE_SPACING]], 'two points in one tick, two chimes');
  for (let i = 0; i < 5; i++) advanceWithSounds(game, 0, sound);
  assert.equal(sound.played.length, 3, 'frames without new points are silent');
  scoreNext(game, 1);
  advanceWithSounds(game, TICK, sound);
  assert.equal(game.score, 3);
  assert.deepEqual(sound.played.slice(3), ['score']);
});

test('points from earlier ticks of a crash frame still sound, then the crash sounds once', () => {
  const game = createGame({ seed: 7 });
  const sound = soundLog();
  startWithSound(game, createFrameClock(), sound);
  scoreNext(game, 2);
  // Falling fast just above the floor: the first tick scores, a later tick of the same frame hits the floor.
  game.bat.y = CAVE_FLOOR + BAT_HALF_HEIGHT + 0.3;
  game.bat.velocity = -12;
  const result = advanceWithSounds(game, MAX_FRAME_SECONDS, sound);
  assert.ok(result.ticks > 1, `the crash came after the first tick (${result.ticks})`);
  assert.equal(result.crashed, true);
  assert.equal(game.score, 2);
  assert.deepEqual(sound.played, ['flap', 'score', ['score', SCORE_SPACING], 'crash']);

  for (let i = 0; i < 5; i++) advanceWithSounds(game, MAX_FRAME_SECONDS, sound);
  assert.equal(sound.played.length, 4, 'over frames never repeat the crash');
  game.reset();
  advanceWithSounds(game, MAX_FRAME_SECONDS, sound);
  assert.equal(sound.played.length, 4, 'the score reset to 0 is not a sound event');
});

test('ready and paused frames make no sound; a resumed flight sounds its new events only', () => {
  const game = createGame({ seed: 7 });
  const sound = soundLog();
  for (let i = 0; i < 5; i++) advanceWithSounds(game, MAX_FRAME_SECONDS, sound);
  startWithSound(game, createFrameClock(), sound);
  scoreNext(game, 1);
  game.pause();
  for (let i = 0; i < 5; i++) advanceWithSounds(game, MAX_FRAME_SECONDS, sound);
  assert.deepEqual(sound.played, ['flap']);
  game.resume();
  assert.deepEqual(sound.played, ['flap'], 'resuming is silent');
  advanceWithSounds(game, TICK, sound);
  assert.deepEqual(sound.played, ['flap', 'score']);
});

// Replays the same seed and the same flap ticks through the sound wiring with frames of uneven length.
function replay(sound) {
  const game = createGame({ seed: 9 });
  const clock = createFrameClock();
  const frames = [1 / 60, 1 / 30, MAX_FRAME_SECONDS, 1 / 144, 1 / 60];
  let counts = { flap: 0, score: 0, crash: 0 };
  const counted = {
    play(name, delay) { const played = sound.play(name, delay); if (played) counts[name] += 1; return played; },
  };
  startWithSound(game, clock, counted);
  let lastDecision = -1;
  for (let f = 0; f < 900 && game.state === 'running'; f++) {
    advanceWithSounds(game, frames[f % frames.length], counted);
    // The same autopilot decision at the same tick in every replay.
    if (game.state === 'running' && game.tick >= lastDecision + 20) {
      lastDecision = game.tick;
      const next = game.obstacles.filter((o) => !o.passed).reduce((a, b) => (b.x < a.x ? b : a));
      if (game.bat.y < Math.max(next.gapY - 0.15, CAVE_FLOOR + 0.6) && game.bat.velocity < 0) flapWithSound(game, counted);
    }
  }
  const model = JSON.stringify({ state: game.state, tick: game.tick, score: game.score, bat: game.bat,
    distance: game.distance, runTime: game.runTime, crash: game.crash, obstacles: game.obstacles });
  return { model, counts, score: game.score, state: game.state };
}

test('sound on, muted and unavailable give the same model for the same seed and ticks', () => {
  const on = createSound({ createContext: contextFactory().create, getStorage: () => memoryStorage() });
  on.unlock();
  const muted = createSound({ createContext: contextFactory().create, getStorage: () => memoryStorage() });
  muted.unlock();
  muted.toggleMute();
  const missing = createSound({ createContext: () => null, getStorage: () => memoryStorage() });
  missing.unlock();
  const silentStub = { play: () => false };

  const reference = replay(silentStub);
  assert.ok(reference.score >= 2, `the replay scores (${reference.score})`);
  for (const [label, sound] of [['on', on], ['muted', muted], ['unavailable', missing]]) {
    const run = replay(sound);
    assert.equal(run.model, reference.model, `${label}: same model`);
    if (label === 'on') {
      assert.equal(run.counts.score, run.score, 'one chime per point');
      assert.equal(run.counts.crash, run.state === 'over' ? 1 : 0, 'one crash sound per crash');
      assert.ok(run.counts.flap >= 2, 'start and flaps sound');
    } else {
      assert.deepEqual(run.counts, { flap: 0, score: 0, crash: 0 }, `${label}: silent`);
    }
  }
});
