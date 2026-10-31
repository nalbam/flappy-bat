import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_SPEED, BAT_HALF_WIDTH, BAT_START_Y, BAT_X, CAVE_BOTTOM, FLAP_VELOCITY, MAX_FRAME_SECONDS,
  MAX_SPEED_BONUS, TICK, TICK_RATE, speedAt,
} from '../docs/game-rules.mjs';
import {
  FIRST_OBSTACLE_X, OBSTACLE_COUNT, OBSTACLE_RECYCLE_X, OBSTACLE_SPACING, START_GAP_RANGE,
  createFrameClock, createGame, startRun,
} from '../docs/game-core.mjs';

const EPS = 1e-9;
const MAX_TICKS_PER_FRAME = Math.round(MAX_FRAME_SECONDS * TICK_RATE);

// Deterministic PRNG (mulberry32) so obstacle gaps repeat between runs.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function snapshot(game) {
  return {
    state: game.state,
    score: game.score,
    tick: game.tick,
    y: game.bat.y,
    velocity: game.bat.velocity,
    runTime: game.runTime,
    distance: game.distance,
    obstacles: game.obstacles.map(({ x, gapY, passed }) => ({ x, gapY, passed })),
  };
}

function assertSameRun(actual, expected, label) {
  for (const key of ['state', 'score', 'tick']) assert.equal(actual[key], expected[key], `${label}: ${key}`);
  for (const key of ['y', 'velocity', 'runTime', 'distance']) {
    assert.ok(Math.abs(actual[key] - expected[key]) < EPS, `${label}: ${key} ${actual[key]} != ${expected[key]}`);
  }
  actual.obstacles.forEach((o, i) => {
    const e = expected.obstacles[i];
    assert.equal(o.passed, e.passed, `${label}: obstacle ${i} passed`);
    assert.ok(Math.abs(o.x - e.x) < EPS && Math.abs(o.gapY - e.gapY) < EPS, `${label}: obstacle ${i} position`);
  });
}

// Flaps when the bat drops below a height that keeps it inside the next gap.
function autopilot(game, margin) {
  const next = game.obstacles.filter((o) => !o.passed).reduce((a, b) => (b.x < a.x ? b : a));
  const target = Math.max(next.gapY - margin, CAVE_BOTTOM + 0.35);
  if (game.bat.y < target && game.bat.velocity < 0) game.flap();
}

// Puts one obstacle at x with its gap at gapY and moves the others out of reach.
function soloObstacle(game, x, gapY) {
  game.obstacles.forEach((o, i) => { o.x = 1000 + i * OBSTACLE_SPACING; });
  const obstacle = game.obstacles[0];
  obstacle.x = x;
  obstacle.gapY = gapY;
  return obstacle;
}

test('speed grows with run time and stops at the cap', () => {
  assert.equal(speedAt(0), BASE_SPEED);
  assert.ok(speedAt(10) > speedAt(5));
  assert.equal(speedAt(1000), BASE_SPEED + MAX_SPEED_BONUS);
});

test('ready and over do not advance the model or bank frame time', () => {
  const game = createGame({ random: seeded(1) });
  const ready = snapshot(game);
  assert.equal(game.advance(0.05), 0);
  game.step();
  assertSameRun(snapshot(game), ready, 'ready');
  assert.equal(game.accumulator, 0);

  game.flap();
  assert.equal(game.advance(TICK), 1, 'a new run does not catch up on time spent in ready');

  game.bat.y = CAVE_BOTTOM - 1;
  game.step();
  assert.equal(game.state, 'over');
  const over = snapshot(game);
  for (let i = 0; i < 5; i++) assert.equal(game.advance(MAX_FRAME_SECONDS), 0);
  game.step();
  assert.equal(game.flap(), false);
  assertSameRun(snapshot(game), over, 'over');
  assert.equal(game.accumulator, 0);
});

test('the start input and a normal flap apply the same single impulse, then gravity pulls down', () => {
  const trace = (game) => {
    const y0 = game.bat.y;
    return Array.from({ length: 90 }, () => { game.step(); return [game.bat.y - y0, game.bat.velocity]; });
  };
  const started = createGame({ random: seeded(2) });
  assert.equal(started.state, 'ready');
  assert.equal(started.flap(), true);
  assert.equal(started.state, 'running');
  assert.equal(started.bat.velocity, FLAP_VELOCITY);
  const afterStart = trace(started);

  const flapped = createGame({ random: seeded(2) });
  flapped.flap();
  for (let i = 0; i < 30; i++) flapped.step();
  flapped.flap();
  flapped.flap(); // a second input before the next tick does not stack
  assert.equal(flapped.bat.velocity, FLAP_VELOCITY);
  const afterFlap = trace(flapped);

  afterStart.forEach(([dy, v], i) => {
    assert.ok(Math.abs(dy - afterFlap[i][0]) < EPS && Math.abs(v - afterFlap[i][1]) < EPS, `tick ${i + 1}`);
  });
  assert.ok(afterStart[0][0] > 0, 'the first tick after the start moves up');
  assert.ok(afterStart.at(-1)[1] < 0 && afterStart.at(-1)[0] < afterStart.at(-2)[0], 'gravity turns the bat down');
});

test('30, 60 and 144 Hz frames and delayed frames give the same run for the same tick inputs', () => {
  // Every pattern sums to 1/6 s (20 ticks), so all of them reach each 20-tick
  // boundary at the end of a frame. Inputs are given only on those boundaries.
  const GRID_TICKS = 20;
  const patterns = {
    '30 Hz': Array(5).fill(1 / 30),
    '60 Hz': Array(10).fill(1 / 60),
    '144 Hz': Array(24).fill(1 / 144),
    'delayed 100 ms frame': [1 / 60, 1 / 60, MAX_FRAME_SECONDS, 1 / 30],
    'alternating 100/67 ms frames': [MAX_FRAME_SECONDS, 1 / 15],
  };
  const SECONDS = 14;
  // Gaps from the middle of each range, so an autopilot that acts every 1/6 s survives.
  const middleGaps = () => { const r = seeded(9); return () => 0.4 + 0.3 * r(); };
  const play = (withInput, onFrame) => {
    const game = createGame({ random: middleGaps() });
    game.flap();
    let decided = 0;
    onFrame(game, () => {
      if (withInput && game.tick % GRID_TICKS === 0 && game.tick !== decided) {
        decided = game.tick;
        autopilot(game, 0.15);
      }
    });
    return snapshot(game);
  };
  for (const withInput of [true, false]) {
    const reference = play(withInput, (game, input) => {
      for (let t = 0; t < SECONDS * TICK_RATE; t++) { game.step(); input(); }
    });
    if (withInput) {
      assert.equal(reference.state, 'running');
      assert.ok(reference.score >= 3, `the scenario scores (${reference.score})`);
      assert.ok(reference.distance > FIRST_OBSTACLE_X - OBSTACLE_RECYCLE_X, 'the first obstacle was recycled');
    } else {
      assert.equal(reference.state, 'over');
    }
    for (const [name, pattern] of Object.entries(patterns)) {
      const result = play(withInput, (game, input) => {
        for (let i = 0; i < SECONDS * 6; i++) for (const dt of pattern) { game.advance(dt); input(); }
      });
      assertSameRun(result, reference, `${name}${withInput ? '' : ' without input'}`);
    }
  }
});

test('frame times that sum to a tick boundary run that tick despite float rounding', () => {
  const game = createGame({ random: seeded(3) });
  game.flap();
  for (let i = 0; i < 24; i++) game.advance(1 / 144);
  assert.equal(game.tick, 20);
});

test('a long frame runs at most the catch-up limit and drops the rest', () => {
  const game = createGame({ random: seeded(4) });
  game.flap();
  assert.equal(game.advance(0.5), MAX_TICKS_PER_FRAME);
  assert.ok(Math.abs(game.runTime - MAX_FRAME_SECONDS) < EPS);
  assert.ok(game.accumulator < TICK);
  assert.equal(game.advance(MAX_FRAME_SECONDS), MAX_TICKS_PER_FRAME, 'a 100 ms frame is caught up in full');
});

test('frame clock: no time on the first frame or after a tab returns, clamped long frames', () => {
  const clock = createFrameClock();
  assert.equal(clock.frame(1000), 0);
  assert.ok(Math.abs(clock.frame(1016) - 0.016) < EPS);
  assert.equal(clock.frame(1010), 0, 'a timestamp before the previous frame gives no time');
  assert.equal(clock.frame(6010), MAX_FRAME_SECONDS);
  clock.reset();
  assert.equal(clock.frame(60000), 0);
  assert.ok(Math.abs(clock.frame(60020) - 0.02) < EPS);
});

test('a hidden tab resumes the run where it stopped', () => {
  const game = createGame({ random: seeded(5) });
  const clock = createFrameClock();
  let now = 0;
  game.flap();
  for (let i = 0; i <= 30; i++) game.advance(clock.frame((now = i * 1000 / 60)));
  assert.equal(game.tick, 60);
  const hidden = snapshot(game);

  clock.reset(); // visibilitychange
  now += 30000;
  assert.equal(game.advance(clock.frame(now)), 0);
  assertSameRun(snapshot(game), hidden, 'first frame after the tab returns');
  assert.equal(game.advance(clock.frame((now += 1000 / 60))), 2);
  assert.equal(game.state, 'running');
});

test('a start or restart simulates no frame time from before the start input', () => {
  const game = createGame({ random: seeded(12) });
  const clock = createFrameClock();
  const frame = (now) => game.advance(clock.frame(now));
  const afterStart = (label, startedAt) => {
    assert.equal(game.state, 'running', label);
    assert.equal(frame(startedAt + 1), 0, `${label}: the frame after the start has no earlier time`);
    assert.equal(game.bat.velocity, FLAP_VELOCITY, `${label}: the start impulse is intact`);
    assert.equal(game.tick, 0, label);
    assert.equal(frame(startedAt + 1 + 1000 / 60), 2, `${label}: later frames run normally`);
  };

  // First start: the last ready frame was 1000 ms, the input lands just before the 1100 ms frame.
  frame(900);
  frame(1000);
  assert.equal(startRun(game, clock), true);
  afterStart('first start', 1099);
  assert.equal(startRun(game, clock), false, 'a running game does not start again');

  // A crash, over frames, then the restart input (setReady then start in main.js).
  game.bat.y = CAVE_BOTTOM - 1;
  game.step();
  assert.equal(game.state, 'over');
  frame(1200);
  assert.equal(startRun(game, clock), false, 'over must go through reset first');
  frame(1300);
  game.reset();
  assert.equal(startRun(game, clock), true);
  afterStart('restart', 1399);

  // Restart right after the crash frame, with no over frame in between.
  game.bat.y = CAVE_BOTTOM - 1;
  frame(1500);
  assert.equal(game.state, 'over');
  game.reset();
  startRun(game, clock);
  afterStart('immediate restart', 1599);
});

test('an obstacle scores once, only after the whole body leaves its back face', () => {
  const game = createGame({ random: seeded(6) });
  game.flap();
  const obstacle = soloObstacle(game, 0.3, game.bat.y);
  const behindBat = () => obstacle.x + obstacle.halfWidth <= game.bat.x - BAT_HALF_WIDTH;
  let centrePassedWithoutPoint = false;
  while (game.score === 0) {
    assert.equal(behindBat(), false, 'no point while the body still overlaps the obstacle');
    game.step();
    assert.equal(game.state, 'running');
    if (game.score === 0 && obstacle.x < game.bat.x) centrePassedWithoutPoint = true;
  }
  assert.ok(centrePassedWithoutPoint, 'passing the obstacle centre alone gives no point');
  assert.ok(behindBat());
  assert.equal(obstacle.passed, true);
  for (let i = 0; i < 60; i++) game.step();
  assert.equal(game.state, 'running');
  assert.equal(game.score, 1, 'repeated ticks do not score the same obstacle again');
});

test('a recycled obstacle scores again exactly once per pass', () => {
  const game = createGame({ random: seeded(11) });
  game.flap();
  const passes = Array(OBSTACLE_COUNT).fill(0);
  while (game.state === 'running' && game.score < OBSTACLE_COUNT + 3) {
    const before = game.obstacles.map((o) => o.passed);
    const score = game.score;
    game.step();
    autopilot(game, 0.4);
    let newly = 0;
    game.obstacles.forEach((o, i) => {
      if (o.passed && !before[i]) { passes[i] += 1; newly += 1; }
    });
    assert.equal(game.score - score, newly, `tick ${game.tick}`);
  }
  assert.equal(game.state, 'running');
  assert.equal(game.score, passes.reduce((a, b) => a + b, 0));
  assert.ok(passes.some((n) => n === 2), 'at least one obstacle was reused and scored again');
});

test('the tick that ends a run adds no point, even when an obstacle clears in it', () => {
  // Half a tick of travel before its back face passes the back of the bat.
  const clearing = (game) => {
    const step = speedAt(game.runTime) * TICK;
    return soloObstacle(game, -(game.obstacles[0].halfWidth + BAT_HALF_WIDTH) + step / 2, game.bat.y);
  };

  const control = createGame({ random: seeded(7) });
  control.flap();
  const scored = clearing(control);
  control.step();
  assert.equal(control.state, 'running');
  assert.equal(control.score, 1, 'without a crash the obstacle scores in this tick');
  assert.equal(scored.passed, true);

  // The cave floor ends the run in the tick the obstacle clears.
  const floor = createGame({ random: seeded(7) });
  floor.flap();
  floor.bat.y = CAVE_BOTTOM + 0.001;
  floor.bat.velocity = -3;
  const cleared = clearing(floor);
  floor.step();
  assert.equal(floor.state, 'over');
  assert.equal(floor.score, 0);
  assert.equal(cleared.passed, false);

  // Another obstacle hits the bat in the tick the first one clears.
  const hit = createGame({ random: seeded(7) });
  hit.flap();
  const first = clearing(hit);
  Object.assign(hit.obstacles[1], { x: 0.5, gapY: hit.bat.y + 3 });
  hit.step();
  assert.equal(hit.state, 'over');
  assert.equal(hit.score, 0);
  assert.equal(first.passed, false);

  // Outside the gap after the obstacle centre passed the bat: a crash, not a point.
  const late = createGame({ random: seeded(7) });
  late.flap();
  soloObstacle(late, -0.5, late.bat.y + 2);
  late.step();
  assert.equal(late.state, 'over');
  assert.equal(late.score, 0);
  late.advance(1);
  assert.equal(late.score, 0, 'no points after the run is over');
});

test('reset restores a fresh ready run after a crash', () => {
  const game = createGame({ random: seeded(8) });
  game.flap();
  soloObstacle(game, 0.3, game.bat.y);
  while (game.score === 0) game.step();
  game.advance(TICK / 2);
  assert.ok(game.accumulator > 0);
  while (game.state === 'running') game.advance(1 / 60);
  assert.ok(game.score > 0 && game.runTime > 0);

  game.reset();
  assert.equal(game.state, 'ready');
  assert.equal(game.score, 0);
  assert.equal(game.tick, 0);
  assert.equal(game.runTime, 0);
  assert.equal(game.distance, 0);
  assert.equal(game.accumulator, 0);
  assert.equal(speedAt(game.runTime), BASE_SPEED);
  assert.deepEqual(game.bat, { x: BAT_X, y: BAT_START_Y, velocity: 0 });
  game.obstacles.forEach((o, i) => {
    assert.equal(o.x, FIRST_OBSTACLE_X + i * OBSTACLE_SPACING);
    assert.equal(o.passed, false);
    assert.ok(o.gapY >= START_GAP_RANGE[0] && o.gapY < START_GAP_RANGE[1]);
  });

  game.flap();
  assert.equal(game.advance(1 / 60), 2);
  assert.equal(game.state, 'running');

  // Frame time left over in a running game does not carry into the next run.
  game.advance(TICK * 0.6);
  game.reset();
  game.flap();
  assert.equal(game.advance(TICK * 0.6), 0);
});
