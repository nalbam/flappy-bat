import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BAT_BODY_RADIUS, BAT_BODY_SCALE, BAT_HALF_HEIGHT, BAT_HALF_WIDTH, BAT_MODEL_YAW, BAT_PITCH_RANGE,
  CAVE_CEILING, CAVE_FLOOR, FLAP_VELOCITY, GRAVITY, MAX_FRAME_SECONDS, TICK, TICK_RATE, bodyPitch, speedAt,
} from '../docs/game-rules.mjs';
import { PILLAR_ROOT, bodyExtents, obstacleParts, sweepBody } from '../docs/collision.mjs';
import {
  OBSTACLE_GAP_HEIGHT, OBSTACLE_HALF_WIDTH, OBSTACLE_SPACING, RESPAWN_GAP_RANGE, START_GAP_RANGE, createGame,
} from '../docs/game-core.mjs';

const NEAR = 1e-6; // a clearance far above CONTACT_TOLERANCE and far below anything visible
const STILL = { x: 0, y: 0 };
const pillar = (x, gapY) => ({ x, gapY, gapHeight: OBSTACLE_GAP_HEIGHT, halfWidth: OBSTACLE_HALF_WIDTH });
const touch = (centre, pitch = 0, obstacles = []) => sweepBody(centre, STILL, pitch, obstacles);
const part = (obstacle, side) => obstacleParts(obstacle).find((p) => p.side === side);

// Centre that puts the body ellipse (pitch 0) against point p, with p's outward normal n
// (pointing from the solid to the body) as the touching direction, moved d along n.
function against([px, py], [nx, ny], d = 0) {
  const len = Math.hypot(nx, ny), ux = nx / len, uy = ny / len;
  const k = 1 / Math.hypot(ux * BAT_HALF_WIDTH, uy * BAT_HALF_HEIGHT);
  return {
    x: px + k * ux * BAT_HALF_WIDTH ** 2 + d * ux,
    y: py + k * uy * BAT_HALF_HEIGHT ** 2 + d * uy,
  };
}

// The body mesh sampled as makeBat builds it: an icosahedron sphere of BAT_BODY_RADIUS scaled
// by BAT_BODY_SCALE, turned by BAT_MODEL_YAW about y, then tilted by `pitch` about z.
function sampledBodyExtents(pitch) {
  let halfWidth = 0, halfHeight = 0;
  for (let i = 0; i <= 180; i++) {
    for (let j = 0; j < 360; j++) {
      const v = (i / 180 - 0.5) * Math.PI, u = j / 360 * 2 * Math.PI;
      const mx = BAT_BODY_RADIUS * BAT_BODY_SCALE[0] * Math.cos(v) * Math.cos(u);
      const my = BAT_BODY_RADIUS * BAT_BODY_SCALE[1] * Math.sin(v);
      const mz = BAT_BODY_RADIUS * BAT_BODY_SCALE[2] * Math.cos(v) * Math.sin(u);
      const x = mx * Math.cos(BAT_MODEL_YAW) + mz * Math.sin(BAT_MODEL_YAW);
      halfWidth = Math.max(halfWidth, Math.abs(x * Math.cos(pitch) - my * Math.sin(pitch)));
      halfHeight = Math.max(halfHeight, Math.abs(x * Math.sin(pitch) + my * Math.cos(pitch)));
    }
  }
  return { halfWidth, halfHeight };
}

// Deterministic PRNG (mulberry32).
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

test('the body outline is the body mesh seen on the play plane, at every tilt the renderer draws', () => {
  assert.ok(Math.abs(BAT_HALF_WIDTH - 0.43) < 1e-12, 'the turned body is 0.43 wide each side');
  assert.ok(Math.abs(BAT_HALF_HEIGHT - 0.516) < 1e-12, 'and 0.43 × 1.2 high each side');
  const [minPitch, maxPitch] = BAT_PITCH_RANGE;
  assert.equal(bodyPitch(-100), minPitch);
  assert.equal(bodyPitch(100), maxPitch);
  assert.ok(bodyPitch(FLAP_VELOCITY) > 0 && bodyPitch(-1) < 0, 'nose up while rising, down while falling');
  for (const pitch of [minPitch, -0.2, 0, 0.1, bodyPitch(FLAP_VELOCITY), maxPitch]) {
    const sampled = sampledBodyExtents(pitch), outline = bodyExtents(pitch);
    assert.ok(Math.abs(sampled.halfWidth - outline.halfWidth) < 2e-4, `half width at pitch ${pitch}`);
    assert.ok(Math.abs(sampled.halfHeight - outline.halfHeight) < 2e-4, `half height at pitch ${pitch}`);
    assert.ok(outline.halfHeight <= BAT_HALF_HEIGHT + 1e-12, 'upright is the tallest pose');
  }
});

test('the body touches a gap edge, the floor or the ceiling exactly when its outline reaches it', () => {
  const obstacle = pillar(0, 2);
  const lower = part(obstacle, 'lower'), upper = part(obstacle, 'upper');
  for (const pitch of [0, 0.3, -0.34]) {
    const h = bodyExtents(pitch).halfHeight;
    const cases = [
      ['lower gap edge', (d) => ({ x: 0, y: lower.edgeY + h + d }), lower.edgeY, 'pillar'],
      ['upper gap edge', (d) => ({ x: 0, y: upper.edgeY - h - d }), upper.edgeY, 'pillar'],
      ['floor', (d) => ({ x: 9, y: CAVE_FLOOR + h + d }), CAVE_FLOOR, 'floor'],
      ['ceiling', (d) => ({ x: 9, y: CAVE_CEILING - h - d }), CAVE_CEILING, 'ceiling'],
    ];
    for (const [name, at, surfaceY, solid] of cases) {
      const label = `${name} at pitch ${pitch}`;
      assert.equal(touch(at(NEAR), pitch, [obstacle]), null, `${label}: just before touching is safe`);
      const contact = touch(at(0), pitch, [obstacle]);
      assert.ok(contact, `${label}: touching counts as a crash`);
      assert.equal(contact.solid, solid, label);
      assert.ok(Math.abs(contact.y - surfaceY) < 1e-9, `${label}: the touched point is on the surface`);
      assert.ok(touch(at(-NEAR), pitch, [obstacle]), `${label}: overlapping is a crash`);
    }
  }
});

test('pillar sides and cut corners follow the outline, not a bounding box', () => {
  const obstacle = pillar(0, 2);
  const lower = part(obstacle, 'lower');
  const w = lower.halfWidth, c = lower.chamfer, edge = lower.edgeY;
  const sideY = edge - c - 0.5; // on the flat side face, below the cut corner
  const n22 = [Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)]; // between the top and the cut normals
  const cases = [
    ['left side face', (d) => ({ x: -w - BAT_HALF_WIDTH - d, y: sideY })],
    ['corner between the gap edge and the cut', (d) => against([w - c, edge], n22, d)],
    ['corner between the cut and the side', (d) => against([w, edge - c], [n22[1], n22[0]], d)],
    ['middle of the cut', (d) => against([w - c / 2, edge - c / 2], [1, 1], d)],
  ];
  for (const [name, at] of cases) {
    assert.equal(touch(at(NEAR), 0, [obstacle]), null, `${name}: just before touching is safe`);
    assert.ok(touch(at(0), 0, [obstacle]), `${name}: touching counts`);
    assert.ok(touch(at(-NEAR), 0, [obstacle]), `${name}: overlapping counts`);
  }

  // Near the cut, the body's bounding box overlaps the pillar but the body itself does not.
  const near = against([w - c / 2, edge - c / 2], [1, 1], 0.03);
  assert.ok(Math.abs(near.x) < w + BAT_HALF_WIDTH && near.y - BAT_HALF_HEIGHT < edge, 'a box test would report a hit');
  assert.equal(touch(near, 0, [obstacle]), null);
});

test('a step longer than a pillar still hits it, at the point the body first touches', () => {
  const obstacle = pillar(0, 2);
  const lower = part(obstacle, 'lower');
  const w = lower.halfWidth;

  // Horizontal: from 1.45 left of touching to 1.45 right of the pillar's back in one step of 5.
  const y = lower.edgeY - lower.chamfer - 0.3;
  const from = { x: -w - BAT_HALF_WIDTH - 1.45, y };
  assert.equal(touch(from, 0, [obstacle]), null, 'free before the step');
  assert.equal(touch({ x: from.x + 5, y }, 0, [obstacle]), null, 'free after the step');
  const hit = sweepBody(from, { x: 5, y: 0 }, 0, [obstacle]);
  assert.ok(hit, 'the swept body hits the pillar between the two free positions');
  assert.ok(Math.abs(hit.time - 1.45 / 5) < 1e-8);
  assert.ok(Math.abs(hit.x + w) < 1e-8 && Math.abs(hit.y - y) < 1e-6, 'the contact is on the near face');

  // Diagonal: from beside the lower pillar into the gap above it, across its corner.
  const side = { x: -1.6, y: lower.edgeY - 0.4 }, gap = { x: 0.2, y: lower.edgeY + 1.2 };
  assert.equal(touch(side, 0, [obstacle]), null);
  assert.equal(touch(gap, 0, [obstacle]), null);
  const corner = sweepBody(side, { x: gap.x - side.x, y: gap.y - side.y }, 0, [obstacle]);
  assert.ok(corner && corner.solid === 'pillar' && corner.time > 0 && corner.time < 1);

  // Vertical: a fall from the gap far below the floor stops on the pillar, not the floor.
  const drop = sweepBody({ x: 0, y: 2 }, { x: 0, y: -8 }, 0, [obstacle]);
  assert.equal(drop.solid, 'pillar');
  assert.ok(Math.abs(drop.y - lower.edgeY) < 1e-9);
  assert.ok(Math.abs(2 - 8 * drop.time - BAT_HALF_HEIGHT - lower.edgeY) < 1e-8, 'the body rests on the edge');

  // Vertical: a rise far past the ceiling stops on it.
  const rise = sweepBody({ x: 9, y: 2 }, { x: 0, y: 10 }, 0.2, [obstacle]);
  assert.equal(rise.solid, 'ceiling');
  assert.ok(Math.abs(2 + 10 * rise.time + bodyExtents(0.2).halfHeight - CAVE_CEILING) < 1e-8);
});

test('a close pass that never touches is not a crash', () => {
  const obstacle = pillar(0, 2);
  const lower = part(obstacle, 'lower');
  const w = lower.halfWidth, c = lower.chamfer, edge = lower.edgeY;

  // Level flight along the gap edge across the whole pillar.
  const skim = (d) => sweepBody({ x: -3, y: edge + BAT_HALF_HEIGHT + d }, { x: 6, y: 0 }, 0, [obstacle]);
  assert.equal(skim(NEAR), null);
  const graze = skim(0);
  assert.ok(graze && Math.abs(graze.x - (-w + c)) < 1e-4, 'touching the edge counts, first at its near corner');

  // Sliding along the cut, parallel to it.
  const slide = (d) => {
    const start = against([w - c / 2, edge - c / 2], [1, 1], d);
    return sweepBody({ x: start.x - 0.6, y: start.y + 0.6 }, { x: 1.2, y: -1.2 }, 0, [obstacle]);
  };
  assert.equal(slide(NEAR), null);
  assert.ok(slide(-NEAR));
});

test('every gap the game generates leaves the body more room than a flap rises', () => {
  // A flap rises v²/2g. On top of that the player gets a quarter second of fall from the apex.
  const rise = FLAP_VELOCITY ** 2 / (2 * GRAVITY);
  const slack = GRAVITY / 2 * 0.25 ** 2;
  for (const [min, max] of [START_GAP_RANGE, RESPAWN_GAP_RANGE]) {
    for (let i = 0; i <= 100; i++) {
      const gapY = min + (max - min) * i / 100;
      const parts = obstacleParts(pillar(0, gapY));
      const floor = parts.find((p) => p.side === 'lower')?.edgeY ?? CAVE_FLOOR;
      const ceiling = parts.find((p) => p.side === 'upper')?.edgeY ?? CAVE_CEILING;
      const room = ceiling - floor - 2 * BAT_HALF_HEIGHT;
      assert.ok(room >= rise + slack, `gapY ${gapY.toFixed(3)}: centre room ${room.toFixed(3)}`);
      assert.ok(floor >= CAVE_FLOOR && ceiling <= CAVE_CEILING);
    }
  }
});

test('outlines: gap edges and buried parts', () => {
  const both = obstacleParts(pillar(3, 2));
  assert.deepEqual(both.map((p) => p.side), ['lower', 'upper']);
  for (const p of both) {
    assert.ok(Math.abs(Math.abs(p.edgeY - 2) - OBSTACLE_GAP_HEIGHT / 2) < 1e-12, `${p.side} edge on the gap`);
    const surface = p.side === 'lower' ? CAVE_FLOOR : CAVE_CEILING;
    assert.ok(Math.abs(Math.abs(p.rootY - surface) - PILLAR_ROOT) < 1e-12, `${p.side} base buried in the rock`);
    const xs = p.polygon.map(([x]) => x), ys = p.polygon.map(([, y]) => y);
    assert.equal(Math.min(...xs), 3 - OBSTACLE_HALF_WIDTH);
    assert.equal(Math.max(...xs), 3 + OBSTACLE_HALF_WIDTH);
    assert.equal(Math.min(...ys), Math.min(p.edgeY, p.rootY));
    assert.equal(Math.max(...ys), Math.max(p.edgeY, p.rootY));
  }
  // A gap edge below the floor leaves only the upper part.
  const low = obstacleParts(pillar(0, CAVE_FLOOR + OBSTACLE_GAP_HEIGHT / 2 - 0.01));
  assert.deepEqual(low.map((p) => p.side), ['upper']);
});

// Game model integration.

// Puts the first obstacles at the given [x, gapY] entries and moves the others out of reach.
function placeObstacles(game, entries) {
  game.obstacles.forEach((o, i) => { o.x = 1000 + i * OBSTACLE_SPACING; });
  return entries.map(([x, gapY], i) => Object.assign(game.obstacles[i], { x, gapY }));
}

test('a crash inside a delayed frame ends the run once, at the touching pose, with no later points', () => {
  const MAX_TICKS = Math.round(MAX_FRAME_SECONDS * TICK_RATE);
  const dx = speedAt(0) * TICK;
  const setUp = (withWall) => {
    const game = createGame({ random: seeded(21) });
    game.flap();
    const reach = bodyExtents(bodyPitch(FLAP_VELOCITY)).halfWidth;
    // Behind the bat with its gap around it: its back face clears the body 7.5 ticks in.
    const entries = [[-OBSTACLE_HALF_WIDTH - reach + 7.5 * dx, game.bat.y]];
    // A wall ahead: the bat is inside the upper pillar's height and reaches it about 4.5 ticks in.
    if (withWall) entries.push([OBSTACLE_HALF_WIDTH + reach + 4.5 * dx, game.bat.y - 3]);
    const [behind, wall] = placeObstacles(game, entries);
    const states = [];
    const step = game.step;
    game.step = () => { step(); states.push(game.state); };
    return { game, behind, wall, states };
  };

  const control = setUp(false);
  assert.equal(control.game.advance(MAX_FRAME_SECONDS), MAX_TICKS);
  assert.equal(control.game.score, 1, 'without the wall the obstacle behind scores within the frame');

  const { game, behind, wall, states } = setUp(true);
  const ticks = game.advance(MAX_FRAME_SECONDS);
  assert.ok(ticks >= 4 && ticks <= 6, `the crash tick (${ticks}) is inside the 12-tick frame`);
  assert.deepEqual(states, [...Array(ticks - 1).fill('running'), 'over'], 'over is entered once, by the last tick run');
  assert.equal(game.score, 0);
  assert.equal(behind.passed, false);

  // The model stops at the first touch of the wall's near face: free just before, overlapping just after.
  assert.equal(game.crash.solid, 'pillar');
  assert.ok(Math.abs(game.crash.x - (wall.x - wall.halfWidth)) < 1e-9, 'contact on the near face');
  const pitch = bodyPitch(game.bat.velocity);
  assert.equal(touch({ x: game.bat.x - NEAR, y: game.bat.y }, pitch, game.obstacles), null, 'free just before the stop');
  assert.ok(touch({ x: game.bat.x + NEAR, y: game.bat.y }, pitch, game.obstacles), 'overlapping just after it');

  const frozen = JSON.stringify([game.bat, game.obstacles, game.crash, game.score]);
  for (let i = 0; i < 3; i++) assert.equal(game.advance(MAX_FRAME_SECONDS), 0);
  assert.equal(states.length, ticks, 'no tick runs after the crash');
  assert.equal(JSON.stringify([game.bat, game.obstacles, game.crash, game.score]), frozen);
});

test('a fall ends with the body on the floor surface', () => {
  const game = createGame({ random: seeded(22) });
  game.flap();
  placeObstacles(game, []);
  while (game.state === 'running') game.advance(1 / 60);
  assert.equal(game.crash.solid, 'floor');
  assert.ok(Math.abs(game.crash.y - CAVE_FLOOR) < 1e-12);
  const bottom = game.bat.y - bodyExtents(bodyPitch(game.bat.velocity)).halfHeight;
  assert.ok(bottom - CAVE_FLOOR >= 0 && bottom - CAVE_FLOOR < 1e-6, `body bottom ${bottom} on the floor`);
});
