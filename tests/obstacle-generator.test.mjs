import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';

import {
  BASE_SPEED, BAT_HALF_HEIGHT, BAT_PITCH_RANGE, CAVE_CEILING, CAVE_FLOOR, FLAP_VELOCITY, GRAVITY, MAX_SPEED_BONUS,
  TICK, TICK_RATE, bodyPitch, speedAt,
} from '../docs/game-rules.mjs';
import { bodyExtents, obstacleParts, sweepBody } from '../docs/collision.mjs';
import { OBSTACLE_COUNT, createGame } from '../docs/game-core.mjs';
import {
  DIFFICULTY_RAMP, FIRST_OBSTACLE_X, GAP_EDGE_RANGE, GAP_HEIGHT_RANGE, MIN_PILLAR_LENGTH, REACTION_SECONDS, READY_SECONDS,
  SAFE_MARGIN, SPACING_RANGE, TARGET_SHIFT, createObstacleGenerator, createRandom, difficulty, isSeed, parseSeed,
} from '../docs/obstacle-generator.mjs';
import { PLAY_VIEW } from '../docs/view.mjs';

const EPS = 1e-9;
const TOP_SPEED = BASE_SPEED + MAX_SPEED_BONUS;

// Seeds whose planned paths are replayed through the game model: 16 × 80 pillars from the start
// input. FLAPPY_BAT_SEEDS=1234,5678 adds seeds, for example one a player reported.
const REPLAY_PILLARS = 80;
const REPLAY_SEEDS = [
  ...Array.from({ length: 16 }, (_, i) => i + 1),
  ...(process.env.FLAPPY_BAT_SEEDS ?? '').split(',').filter((text) => text.trim()).map((text) => {
    const seed = parseSeed(text);
    if (seed === null) throw new RangeError(`FLAPPY_BAT_SEEDS: not a seed: ${text}`);
    return seed;
  }),
];

const take = (seed, count, options) => {
  const generator = createObstacleGenerator(seed, options);
  return Array.from({ length: count }, () => generator.next());
};

// The planned flap ticks of a seed up to the exit of pillar `count - 1`, and the descriptors of
// every obstacle the model sets up by then (it places up to OBSTACLE_COUNT ahead of the bat).
function plan(seed, count) {
  const descriptors = take(seed, count + OBSTACLE_COUNT);
  const flown = descriptors.slice(0, count);
  return { descriptors, flaps: new Set(flown.flatMap((d) => d.path.flaps)), end: flown.at(-1).path.exit.tick };
}

// Plays the planned inputs of `game.seed` through the model, one step() per tick, until the bat
// has left the last of `count` pillars. Tick 0 has the start input. `onTick` runs after each tick.
function replay(game, count, onTick = () => {}) {
  const { descriptors, flaps, end } = plan(game.seed, count);
  while (game.tick < end) {
    if (flaps.has(game.tick)) game.flap();
    game.step();
    if (game.state !== 'running') assert.fail(`seed ${game.seed}: ${game.crash.solid} touched at tick ${game.tick}`);
    onTick(game);
  }
  return descriptors;
}

test('a seed repeats its descriptors, effect randomness does not change them, and seeds differ', () => {
  const realRandom = Math.random;
  let reference;
  Math.random = () => { throw new Error('obstacle generation drew from Math.random'); };
  try {
    reference = take(424242, 150);
    createGame({ seed: 424242 }).reset();
  } finally {
    Math.random = realRandom;
  }
  // Rocks, materials and particles draw from Math.random between obstacles: same descriptors.
  const generator = createObstacleGenerator(424242);
  const interleaved = reference.map(() => { for (let i = 0; i < 7; i++) Math.random(); return generator.next(); });
  assert.deepEqual(interleaved, reference);

  // Gap height, gap position and spacing all vary within a run.
  const spread = (key) => Math.max(...reference.map((d) => d[key])) - Math.min(...reference.map((d) => d[key]));
  assert.ok(spread('gapY') > 2 && spread('gapHeight') > 0.5 && spread('spacing') > 3, 'descriptors vary');

  // Every seed gives its own layout from the first pillars on.
  const layouts = Array.from({ length: 50 }, (_, seed) => JSON.stringify(take(seed, 6).map((d) => [d.gapY, d.gapHeight, d.spacing])));
  assert.equal(new Set(layouts).size, layouts.length);
});

test('frame splits and effect randomness do not change the obstacles or the run', () => {
  const SEED = 77, PILLARS = 30;
  const { descriptors, flaps, end } = plan(SEED, PILLARS);
  // Records each obstacle the first time it shows up in the row.
  const watch = () => {
    const placed = new Map();
    return (game) => { for (const o of game.obstacles) if (!placed.has(o.index)) placed.set(o.index, [o.gapY, o.gapHeight]); return placed; };
  };

  const reference = createGame({ seed: SEED });
  const seenByTick = watch();
  seenByTick(reference);
  replay(reference, PILLARS, seenByTick);

  // Frames of 1 to 12 ticks, each ending before a planned flap, with effects drawing randoms in between.
  const game = createGame({ seed: SEED });
  const seenByFrame = watch();
  const frameTicks = createRandom(5);
  seenByFrame(game);
  while (game.tick < end) {
    if (flaps.has(game.tick)) game.flap();
    let ticks = 1 + Math.floor(frameTicks() * 12);
    for (let t = 1; t < ticks; t++) if (flaps.has(game.tick + t)) { ticks = t; break; }
    ticks = Math.min(ticks, end - game.tick);
    const before = game.tick;
    game.advance(ticks * TICK);
    assert.equal(game.tick - before, ticks, 'the frame runs its whole ticks');
    Math.random();
    seenByFrame(game);
  }
  const placed = seenByFrame(game);
  assert.equal(game.state, 'running');
  for (const key of ['tick', 'score', 'distance', 'runTime']) assert.equal(game[key], reference[key], key);
  assert.deepEqual(game.bat, reference.bat);
  assert.deepEqual(game.obstacles, reference.obstacles);
  assert.deepEqual(placed, seenByTick(reference));
  assert.ok(placed.size > OBSTACLE_COUNT, 'obstacles were reused');
  for (const [index, gap] of placed) assert.deepEqual(gap, [descriptors[index].gapY, descriptors[index].gapHeight], `obstacle ${index}`);
});

test('the body can first touch the first pillar READY_SECONDS after the start input', () => {
  for (const seed of [3, 4, 5]) {
    const { flaps } = plan(seed, 1);
    const game = createGame({ seed });
    const first = game.obstacles.find((o) => o.index === 0);
    assert.equal(first.x, FIRST_OBSTACLE_X);
    // The widest body at the height of the lower pillar touches it as soon as it reaches it.
    const wide = BAT_PITCH_RANGE.reduce((a, b) => (bodyExtents(b).halfWidth > bodyExtents(a).halfWidth ? b : a));
    const lower = obstacleParts(first).find((p) => p.side === 'lower');
    const y = lower.edgeY - 0.1;
    let contact = null;
    while (!contact) {
      const hit = sweepBody({ x: game.bat.x, y }, { x: speedAt(game.runTime) * TICK, y: 0 }, wide, [first]);
      if (hit) contact = (game.tick + hit.time) * TICK;
      if (flaps.has(game.tick)) game.flap();
      game.step();
      assert.equal(game.state, 'running');
    }
    assert.ok(contact >= READY_SECONDS - EPS, `seed ${seed}: first possible contact at ${contact} s`);
    assert.ok(contact <= READY_SECONDS + TICK, `seed ${seed}: the bound is tight (${contact} s)`);
  }
});

test('the planned path turns toward a pillar only a reaction time after it comes on screen', () => {
  const SEED = 9, PILLARS = 30;
  const base = take(SEED, PILLARS);
  // Tick at which each pillar's centre comes within PLAY_VIEW.ahead of the bat, the look-ahead every screen shows.
  const seen = new Map();
  const game = createGame({ seed: SEED });
  replay(game, PILLARS, () => {
    for (const o of game.obstacles) if (!seen.has(o.index) && o.x - game.bat.x <= PLAY_VIEW.ahead) seen.set(o.index, game.tick);
  });
  let turned = 0;
  for (let n = 1; n < PILLARS; n++) {
    // The same run, except that the path keeps its hover height for pillar n.
    const kept = take(SEED, PILLARS, { difficultyAt: (i) => (i === n ? { ...difficulty(i), shift: 0 } : difficulty(i)) });
    assert.deepEqual(kept.slice(0, n), base.slice(0, n), `pillars before ${n} do not change`);
    const react = seen.get(n) + Math.round(REACTION_SECONDS * TICK_RATE);
    const early = (d) => d.path.flaps.filter((t) => t < react);
    assert.deepEqual(early(kept[n]), early(base[n]), `pillar ${n}: no different input before tick ${react}`);
    if (JSON.stringify(kept[n].path.flaps) !== JSON.stringify(base[n].path.flaps)) turned += 1;
  }
  assert.ok(turned >= PILLARS / 2, `the target changes the path after the reaction time (${turned} pillars)`);
});

test('difficulty ramps from the easy to the hard ranges and then holds', () => {
  const easy = difficulty(0), hard = difficulty(DIFFICULTY_RAMP);
  assert.deepEqual([easy.gapHeight, easy.spacing, easy.shift, easy.progress], [GAP_HEIGHT_RANGE.easy, SPACING_RANGE.easy, TARGET_SHIFT.easy, 0]);
  assert.deepEqual([hard.gapHeight, hard.spacing, hard.shift, hard.progress], [GAP_HEIGHT_RANGE.hard, SPACING_RANGE.hard, TARGET_SHIFT.hard, 1]);
  assert.deepEqual(difficulty(100000), hard);
  for (let i = 1; i <= DIFFICULTY_RAMP; i++) {
    const [a, b] = [difficulty(i - 1), difficulty(i)];
    assert.ok(b.gapHeight[0] < a.gapHeight[0] && b.spacing[0] < a.spacing[0] && b.shift > a.shift, `index ${i} is harder`);
  }
});

test('long runs keep gap height, gap position and spacing inside the documented ranges', () => {
  // Body room above a flap: one flap rise plus a quarter second of fall from the apex.
  const flapRoom = FLAP_VELOCITY ** 2 / (2 * GRAVITY) + GRAVITY / 2 * 0.25 ** 2;
  for (const seed of [1, 2, 3, 4, 5]) {
    let previousX = 0;
    take(seed, 3000).forEach((d, i) => {
      const range = difficulty(i), label = `seed ${seed} obstacle ${i}`;
      assert.equal(d.index, i);
      assert.ok(d.gapHeight >= range.gapHeight[0] - EPS && d.gapHeight <= range.gapHeight[1] + EPS, `${label}: gap height ${d.gapHeight}`);
      if (i === 0) assert.equal(d.x, FIRST_OBSTACLE_X);
      else assert.ok(d.spacing >= range.spacing[0] - EPS && d.spacing <= range.spacing[1] + EPS, `${label}: spacing ${d.spacing}`);
      assert.ok(Math.abs(d.x - previousX - d.spacing) < 1e-9, `${label}: spacing from the previous pillar`);
      previousX = d.x;
      // Both pillars show at least MIN_PILLAR_LENGTH, so the gap never opens onto the floor or the ceiling.
      const parts = obstacleParts({ ...d, halfWidth: 0.62 });
      assert.deepEqual(parts.map((p) => p.side), ['lower', 'upper'], label);
      assert.ok(parts[0].edgeY >= GAP_EDGE_RANGE[0] - EPS && parts[0].edgeY - CAVE_FLOOR >= MIN_PILLAR_LENGTH - EPS, `${label}: lower edge`);
      assert.ok(parts[1].edgeY <= GAP_EDGE_RANGE[1] + EPS && CAVE_CEILING - parts[1].edgeY >= MIN_PILLAR_LENGTH - EPS, `${label}: upper edge`);
      assert.ok(d.gapHeight - 2 * BAT_HALF_HEIGHT >= flapRoom, `${label}: room for a flap`);
      // The planned body keeps SAFE_MARGIN to both gap edges while it passes.
      assert.ok(d.path.low - parts[0].edgeY >= SAFE_MARGIN - EPS && parts[1].edgeY - d.path.high >= SAFE_MARGIN - EPS, `${label}: planned clearance`);
    });
  }
});

test('planned paths from the start input pass every pillar of 16 seeds × 80 through the game model', () => {
  const stats = { pairs: 0, accelerating: 0, hardest: 0, narrowest: Infinity, biggestShift: 0, clearance: Infinity, exitVelocities: [] };
  for (const seed of REPLAY_SEEDS) {
    const game = createGame({ seed });
    const { descriptors } = plan(seed, REPLAY_PILLARS);
    const exits = new Map(descriptors.slice(0, REPLAY_PILLARS).map((d) => [d.path.exit.tick, d]));
    const scored = new Set();
    replay(game, REPLAY_PILLARS, () => {
      // Each segment continues from the exact state at which the model leaves the previous pillar.
      const exit = exits.get(game.tick);
      if (exit && (game.bat.y !== exit.path.exit.y || game.bat.velocity !== exit.path.exit.velocity)) {
        assert.fail(`seed ${seed}: the model leaves pillar ${exit.index} at another state than planned`);
      }
      // The body the model tests keeps SAFE_MARGIN to the cave and to the gap edges of every pillar it is beside.
      const ext = bodyExtents(bodyPitch(game.bat.velocity));
      const bottom = game.bat.y - ext.halfHeight, top = game.bat.y + ext.halfHeight;
      let clearance = Math.min(bottom - CAVE_FLOOR, CAVE_CEILING - top);
      for (const o of game.obstacles) {
        if (Math.abs(o.x - game.bat.x) > o.halfWidth + ext.halfWidth) continue;
        clearance = Math.min(clearance, bottom - (o.gapY - o.gapHeight / 2), o.gapY + o.gapHeight / 2 - top);
      }
      if (clearance < SAFE_MARGIN - 1e-9) assert.fail(`seed ${seed}: clearance ${clearance} at tick ${game.tick}`);
      stats.clearance = Math.min(stats.clearance, clearance);
      // Reused obstacles stay in generation order at their generated spacing and score once each.
      const row = [...game.obstacles].sort((a, b) => a.x - b.x);
      for (let i = 0; i < row.length; i++) {
        const o = row[i], d = descriptors[o.index];
        if (Math.abs(o.x + game.distance - d.x) > 1e-6) assert.fail(`seed ${seed}: obstacle ${o.index} is off its generated x`);
        if (i > 0 && (o.index !== row[i - 1].index + 1 || o.x - row[i - 1].x < SPACING_RANGE.hard[0] - 1e-6)) {
          assert.fail(`seed ${seed}: obstacles ${row[i - 1].index} and ${o.index} out of order or too close`);
        }
        if (o.passed && !scored.has(o.index)) scored.add(o.index);
      }
      if (game.score !== scored.size) assert.fail(`seed ${seed}: score ${game.score} for ${scored.size} passed pillars`);
    });
    assert.equal(game.score, REPLAY_PILLARS, `seed ${seed}: every planned pillar scores once`);
    assert.equal(game.obstacles.length, OBSTACLE_COUNT);

    descriptors.slice(0, REPLAY_PILLARS).forEach((d, i) => {
      const atTopSpeed = speedAt(d.path.exit.tick * TICK) === TOP_SPEED;
      if (!atTopSpeed) stats.accelerating += 1;
      if (atTopSpeed && difficulty(i).progress === 1) {
        stats.hardest += 1;
        stats.narrowest = Math.min(stats.narrowest, d.gapHeight);
        if (i > 0) stats.biggestShift = Math.max(stats.biggestShift, Math.abs(d.gapY - descriptors[i - 1].gapY));
      }
      stats.exitVelocities.push(d.path.exit.velocity);
    });
    stats.pairs += REPLAY_PILLARS - 1;
  }
  // The replays cover the start, the acceleration, the top speed with the hardest ranges, the
  // narrowest gaps, large gap moves, and pillars left while falling as well as rising.
  assert.ok(stats.pairs >= 1000, `${stats.pairs} connected pillar pairs`);
  assert.ok(stats.accelerating >= 300, `${stats.accelerating} pillars before the top speed`);
  assert.ok(stats.hardest >= 900, `${stats.hardest} pillars at the top speed with the hardest ranges`);
  assert.ok(stats.narrowest < GAP_HEIGHT_RANGE.hard[0] + 0.01, `narrowest gap ${stats.narrowest}`);
  assert.ok(stats.biggestShift > 2.5, `largest gap move at the top speed ${stats.biggestShift}`);
  assert.ok(Math.min(...stats.exitVelocities) < -FLAP_VELOCITY && Math.max(...stats.exitVelocities) > 0.9 * FLAP_VELOCITY);
  assert.ok(stats.clearance < SAFE_MARGIN + 0.01, `the path comes close to the margin (${stats.clearance})`);
});

test('a safe plan exists with the hardest ranges from the first pillar, at the start speed', () => {
  const hardest = () => difficulty(DIFFICULTY_RAMP);
  // The last retry keeps the current hover height; forcing it at the narrowest gap shows it always fits.
  const keepHover = () => ({ ...hardest(), gapHeight: [GAP_HEIGHT_RANGE.hard[0], GAP_HEIGHT_RANGE.hard[0]], shift: 0 });
  // Pillars much closer than the game places them leave the path little time to settle into a hover
  // after a large move; every plan still settles before the next pillar, so the retries never run out.
  const crowded = () => ({ ...hardest(), spacing: [4, 4] });
  for (const difficultyAt of [hardest, keepHover, crowded]) {
    for (let seed = 1; seed <= 100; seed++) {
      for (const d of take(seed, 60, { difficultyAt })) {
        const bottom = d.gapY - d.gapHeight / 2, top = d.gapY + d.gapHeight / 2;
        assert.ok(d.path.low - bottom >= SAFE_MARGIN - EPS && top - d.path.high >= SAFE_MARGIN - EPS, `seed ${seed} obstacle ${d.index}`);
      }
    }
  }
});

test('long runs and restarts keep the 9 obstacles at the speed cap and retain no generation history', () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const heapUsed = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
  let seed = 100;
  const game = createGame({ seed: () => ++seed });
  const obstacles = game.obstacles, objects = [...obstacles];
  const run = (pillars) => {
    let fastest = 0, last = 0;
    replay(game, pillars, () => { fastest = Math.max(fastest, game.distance - last); last = game.distance; });
    assert.ok(fastest <= TOP_SPEED * TICK + EPS, `scroll per tick ${fastest}`);
    assert.ok(game.obstacles === obstacles && obstacles.length === OBSTACLE_COUNT && obstacles.every((o, i) => o === objects[i]));
    game.bat.y = CAVE_FLOOR - 1; // crash, then restart with the next seed
    game.step();
    assert.equal(game.state, 'over');
    game.reset();
    return game.runTime;
  };
  run(40);
  const before = heapUsed();
  for (let i = 0; i < 4; i++) run(250); // about 3 minutes of play each, most of it at the speed cap
  for (let i = 0; i < 30; i++) run(5);
  const grown = heapUsed() - before;
  // Without history the heap grows by about 40 KB here; keeping the descriptors of these runs holds about 750 KB.
  assert.ok(grown < 150 * 1024, `retained heap grew by ${(grown / 1024).toFixed(0)} KB`);
  assert.equal(seed, 136, 'the first reset and every restart drew a new seed');
});

test('seeds: URL text, validation, and a fresh seed per run without Math.random', () => {
  for (const [text, seed] of [['42', 42], [' 7 ', 7], ['0', 0], ['4294967295', 4294967295]]) assert.equal(parseSeed(text), seed, text);
  for (const text of ['4294967296', '-1', '1.5', '1e3', 'abc', '', null, undefined]) assert.equal(parseSeed(text), null, String(text));
  for (const seed of [-1, 1.5, 2 ** 32, '5', NaN]) {
    assert.throws(() => createObstacleGenerator(seed), RangeError);
    assert.throws(() => createGame({ seed }), RangeError);
  }

  // A seed function gives each run its own seed and layout.
  const seeds = [5, 6];
  const game = createGame({ seed: () => seeds.shift() });
  assert.equal(game.seed, 5);
  game.reset();
  assert.equal(game.seed, 6);
  const sixth = take(6, OBSTACLE_COUNT);
  game.obstacles.forEach((o, i) => assert.deepEqual([o.index, o.gapY, o.gapHeight], [i, sixth[i].gapY, sixth[i].gapHeight]));

  // By default every run draws a new seed from the cryptographic source, not from Math.random.
  const realRandom = Math.random;
  Math.random = () => { throw new Error('seed drawn from Math.random'); };
  try {
    const fresh = createGame();
    const drawn = [fresh.seed];
    for (let i = 0; i < 3; i++) { fresh.reset(); drawn.push(fresh.seed); }
    assert.ok(drawn.every(isSeed), String(drawn));
    assert.ok(new Set(drawn).size > 1, `runs draw new seeds: ${drawn}`);
  } finally {
    Math.random = realRandom;
  }
});
