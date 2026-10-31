import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CAVE_CEILING, CAVE_FLOOR } from '../docs/game-rules.mjs';
import { obstacleParts } from '../docs/collision.mjs';
import { OBSTACLE_GAP_HEIGHT, OBSTACLE_HALF_WIDTH, RESPAWN_GAP_RANGE, START_GAP_RANGE } from '../docs/game-core.mjs';
import {
  CAVE_LIP_DEPTH, PILLAR_DEPTH, STONE_MARGIN, TUNNEL_SEGMENT_LENGTH, pillarMesh, tunnelSections, tunnelSegmentMesh,
} from '../docs/rock-mesh.mjs';

const EPS = 1e-12;

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

const vertices = ({ positions }) => Array.from({ length: positions.length / 3 }, (_, i) => positions.slice(i * 3, i * 3 + 3));
const triangles = (mesh) => {
  const v = vertices(mesh);
  return Array.from({ length: mesh.indices.length / 3 }, (_, i) => mesh.indices.slice(i * 3, i * 3 + 3).map((k) => v[k]));
};

// Signed distance from (x, y) to a convex counter-clockwise polygon: negative inside.
function signedDistance([x, y], polygon) {
  let inside = -Infinity, outside = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[(i + 1) % polygon.length];
    const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey);
    inside = Math.max(inside, (ey * (x - ax) - ex * (y - ay)) / len);
    const u = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (len * len)));
    outside = Math.min(outside, Math.hypot(x - ax - u * ex, y - ay - u * ey));
  }
  return inside > 0 ? outside : inside;
}

// Gap heights across both generation ranges, plus edges that sit just above the floor or ceiling.
const GAPS = [...START_GAP_RANGE, ...RESPAWN_GAP_RANGE, 0.3, 1.1,
  CAVE_FLOOR + OBSTACLE_GAP_HEIGHT / 2 + 0.05, CAVE_CEILING - OBSTACLE_GAP_HEIGHT / 2 - 0.05];
const PARTS = GAPS.flatMap((gapY) => obstacleParts({ x: 0, gapY, gapHeight: OBSTACLE_GAP_HEIGHT, halfWidth: OBSTACLE_HALF_WIDTH }));

test('the pillar mesh meets the play plane exactly on its collision outline', () => {
  assert.ok(PARTS.length >= GAPS.length, 'most gaps have both parts');
  PARTS.forEach((part, n) => {
    const mesh = pillarMesh(part, seeded(n + 1));
    const label = `${part.side} part, edge ${part.edgeY.toFixed(3)}`;
    const onPlane = vertices(mesh).filter(([, , z]) => z === 0);
    for (const v of vertices(mesh)) {
      assert.ok(signedDistance(v, part.polygon) <= EPS, `${label}: vertex ${v} is inside the outline seen from the side`);
    }
    for (const v of onPlane) {
      assert.ok(Math.abs(signedDistance(v, part.polygon)) <= EPS, `${label}: play-plane vertex ${v} is on the outline`);
    }
    for (const [x, y] of part.polygon) {
      assert.ok(onPlane.some(([vx, vy]) => Math.abs(vx - x) < EPS && Math.abs(vy - y) < EPS), `${label}: corner ${x},${y} is a mesh vertex`);
    }
    // The gap end is a ridge on the play plane, so in perspective too the pillar ends on the gap edge.
    for (const [, y, z] of vertices(mesh)) {
      if (y === part.edgeY) assert.equal(z, 0, `${label}: gap-end vertex off the play plane`);
    }
    // No triangle crosses the play plane, so its slice is only the mesh edges on z = 0.
    const mid = (part.edgeY + part.rootY) / 2;
    for (const t of triangles(mesh)) {
      const zs = t.map(([, , z]) => z);
      assert.ok(!(Math.min(...zs) < 0 && Math.max(...zs) > 0), `${label}: a triangle crosses z = 0`);
      // Faces wind outward, so lighting treats the outside as the front.
      const [a, b, c] = t;
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const out = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3 - mid, (a[2] + b[2] + c[2]) / 3];
      assert.ok(normal[0] * out[0] + normal[1] * out[1] + normal[2] * out[2] > 0, `${label}: an inward face`);
    }
  });
});

test('pillar stones stay inside the visible outline and out of the passage', () => {
  let count = 0;
  PARTS.forEach((part, n) => {
    for (const stone of pillarMesh(part, seeded(100 + n)).stones) {
      count += 1;
      const bound = stone.radius * Math.max(1, stone.scaleY);
      const label = `${part.side} stone at ${stone.x.toFixed(3)},${stone.y.toFixed(3)}`;
      assert.ok(signedDistance([stone.x, stone.y], part.polygon) <= -(bound + STONE_MARGIN) + 1e-9, `${label}: inside the outline with margin`);
      const surface = part.side === 'lower' ? CAVE_FLOOR : CAVE_CEILING;
      assert.ok(Math.abs(stone.y - surface) >= bound + STONE_MARGIN - 1e-9, `${label}: on the visible part, not in the rock`);
      assert.notEqual(stone.z, 0, `${label}: on the front or back face, off the play plane`);
      assert.ok(Math.abs(stone.z) + bound <= PILLAR_DEPTH + 1e-12, `${label}: no deeper than the pillar faces`);
    }
  });
  assert.ok(count >= PARTS.length, `stones are placed (${count})`);
});

test('the cave floor and ceiling meet the play plane on the collision surfaces, with no seams', () => {
  const COUNT = 18;
  const sections = tunnelSections(COUNT, seeded(200));
  const meshes = sections.map((left, i) => tunnelSegmentMesh(left, sections[(i + 1) % COUNT], seeded(300 + i)));
  meshes.forEach((mesh, i) => {
    const all = vertices(mesh);
    const near = all.filter(([, , z]) => z <= 0 && z >= -CAVE_LIP_DEPTH);
    for (const end of [-TUNNEL_SEGMENT_LENGTH / 2, TUNNEL_SEGMENT_LENGTH / 2]) {
      const at = (y, z) => near.some((v) => v[0] === end && v[1] === y && v[2] === z);
      assert.ok(at(CAVE_FLOOR, 0) && at(CAVE_CEILING, 0), `segment ${i}: both ends meet the play plane on the surfaces`);
    }
    for (const [x, y, z] of near) assert.ok(y === CAVE_FLOOR || y === CAVE_CEILING, `segment ${i}: ${x},${y},${z} on a surface`);
    // Rock that reaches the play slab (z >= -CAVE_LIP_DEPTH) lies wholly below the floor or above the ceiling.
    for (const t of triangles({ positions: mesh.positions, indices: [...mesh.indices, ...mesh.rimIndices] })) {
      if (!t.some(([, , z]) => z > -CAVE_LIP_DEPTH)) continue;
      const ys = t.map(([, y]) => y);
      assert.ok(Math.max(...ys) <= CAVE_FLOOR || Math.min(...ys) >= CAVE_CEILING, `segment ${i}: rock reaches into the flight band`);
    }
    // The right end of each segment is the left end of the next one, including the last and the first.
    const next = vertices(meshes[(i + 1) % COUNT]);
    const rightEnd = all.filter(([x]) => x === TUNNEL_SEGMENT_LENGTH / 2).map(([, y, z]) => [y, z]);
    const leftEnd = next.filter(([x]) => x === -TUNNEL_SEGMENT_LENGTH / 2).map(([, y, z]) => [y, z]);
    assert.deepEqual(rightEnd, leftEnd, `segment ${i}: a seam with the next segment`);
    for (const p of mesh.pebbles) {
      assert.ok(p.z + p.radius < -CAVE_LIP_DEPTH, `segment ${i}: pebble behind the play slab`);
      assert.ok(Math.abs(p.x) + p.radius <= TUNNEL_SEGMENT_LENGTH / 2, `segment ${i}: pebble inside its segment`);
    }
  });
});
