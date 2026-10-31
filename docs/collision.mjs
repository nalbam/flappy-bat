/* Flappy Bat collision: shared play-plane outlines of the bat body, pillars and cave, and a
   continuous contact test over one tick. Plain values and pure functions, no DOM or THREE. */
import { BAT_HALF_HEIGHT, BAT_HALF_WIDTH, CAVE_CEILING, CAVE_FLOOR } from './game-rules.mjs';

/**
 * Contact rule: the body touches a solid when the body ellipse, scaled about its centre by
 * 1 + CONTACT_TOLERANCE, shares at least one point with the solid. Touching counts as a crash.
 * The tolerance only absorbs float rounding; it moves the contact by less than 1e-9 units.
 */
export const CONTACT_TOLERANCE = 1e-9;

// A pillar part on the play plane is a rectangle of the obstacle's half width whose two
// corners at the gap are cut by PILLAR_CHAMFER. It runs from the gap edge to PILLAR_ROOT
// beyond the cave surface, so its base is buried in the floor or the ceiling.
export const PILLAR_CHAMFER = 0.16;
export const PILLAR_ROOT = 0.4;

/** Half extents along x and y of the body ellipse tilted by `pitch` radians. */
export function bodyExtents(pitch) {
  const c = Math.cos(pitch), s = Math.sin(pitch);
  return {
    halfWidth: Math.hypot(BAT_HALF_WIDTH * c, BAT_HALF_HEIGHT * s),
    halfHeight: Math.hypot(BAT_HALF_WIDTH * s, BAT_HALF_HEIGHT * c),
  };
}

/**
 * Play-plane outlines of an obstacle `{ x, gapY, gapHeight, halfWidth }`. Collision and the
 * pillar meshes both use them. A part whose gap edge is at or beyond the cave surface is
 * buried in the rock and is left out, because the floor or the ceiling already stops the body.
 *
 * @returns {Array<{side: 'lower'|'upper', x: number, halfWidth: number, chamfer: number,
 *   edgeY: number, rootY: number, polygon: Array<[number, number]>}>}
 *   `edgeY` is the gap edge, `rootY` the buried base, `polygon` the convex outline (counter-clockwise).
 */
export function obstacleParts({ x, gapY, gapHeight, halfWidth: w }) {
  const c = PILLAR_CHAMFER; // halfWidth must be larger, so the gap edge keeps a flat part
  const bottom = gapY - gapHeight / 2, top = gapY + gapHeight / 2;
  const parts = [];
  if (bottom > CAVE_FLOOR) {
    const root = CAVE_FLOOR - PILLAR_ROOT;
    parts.push({
      side: 'lower', x, halfWidth: w, chamfer: c, edgeY: bottom, rootY: root,
      polygon: [[x - w, root], [x + w, root], [x + w, bottom - c], [x + w - c, bottom], [x - w + c, bottom], [x - w, bottom - c]],
    });
  }
  if (top < CAVE_CEILING) {
    const root = CAVE_CEILING + PILLAR_ROOT;
    parts.push({
      side: 'upper', x, halfWidth: w, chamfer: c, edgeY: top, rootY: root,
      polygon: [[x - w, top + c], [x - w + c, top], [x + w - c, top], [x + w, top + c], [x + w, root], [x - w, root]],
    });
  }
  return parts;
}

// Nearest point of a convex counter-clockwise polygon; `distance` is 0 when the point is inside.
function closestOnPolygon(px, py, polygon) {
  let inside = true, best = Infinity, bx = px, by = py;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i], [cx, cy] = polygon[(i + 1) % polygon.length];
    const ex = cx - ax, ey = cy - ay;
    if (ex * (py - ay) - ey * (px - ax) < 0) inside = false;
    const u = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey)));
    const qx = ax + u * ex, qy = ay + u * ey, d = Math.hypot(px - qx, py - qy);
    if (d < best) { best = d; bx = qx; by = qy; }
  }
  return { distance: inside ? 0 : best, x: bx, y: by };
}

// Earliest t >= 0 at which a point moving from the origin along (dx, dy) reaches distance r
// of (cx, cy), when it starts farther away. Uses the cancellation-free form of the root.
function circleEntry(dx, dy, cx, cy, r) {
  const a = dx * dx + dy * dy, b = dx * cx + dy * cy, k = cx * cx + cy * cy - r * r;
  if (a === 0 || b <= 0) return null;
  const disc = b * b - a * k;
  return disc < 0 ? null : k / (b + Math.sqrt(disc));
}

// Earliest t in [0, 1] at which a disk of radius r moving from the origin along (dx, dy)
// touches a convex counter-clockwise polygon. The disk first touches either an edge face
// (the edge moved out by r) or a vertex, so those are the only candidates.
function sweepDisk(dx, dy, polygon, r) {
  if (closestOnPolygon(0, 0, polygon).distance <= r) return 0;
  let best = null;
  const keep = (t) => { if (t !== null && t <= 1 && (best === null || t < best)) best = t; };
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i], [cx, cy] = polygon[(i + 1) % polygon.length];
    const ex = cx - ax, ey = cy - ay, len2 = ex * ex + ey * ey, len = Math.sqrt(len2);
    const nx = ey / len, ny = -ex / len; // outward normal of a counter-clockwise edge
    const s0 = -(nx * ax + ny * ay), sd = nx * dx + ny * dy;
    if (sd < 0 && s0 > r) {
      const t = (s0 - r) / -sd;
      const u = ((t * dx - ax) * ex + (t * dy - ay) * ey) / len2;
      if (u >= 0 && u <= 1) keep(t);
    }
    keep(circleEntry(dx, dy, ax, ay, r));
  }
  return best;
}

// Earliest t in [0, 1] at which a centre-to-surface distance `gap`, shrinking by `closing`
// over the tick, reaches `reach`.
function surfaceEntry(gap, closing, reach) {
  if (gap <= reach) return 0;
  if (closing <= 0) return null;
  const t = (gap - reach) / closing;
  return t <= 1 ? t : null;
}

/**
 * First contact of the bat body during one tick of straight-line motion.
 *
 * The body is the ellipse of BAT_HALF_WIDTH × BAT_HALF_HEIGHT tilted by `pitch`, which stays
 * the same for the whole tick. Its centre moves from `from` to `from + motion` while the
 * obstacles stay where they are at the start of the tick, so `motion.x` is the world scroll
 * of the tick. Every point of the path is tested, so a step longer than a pillar is wide
 * still hits it. The test maps the plane so the body becomes a disk, which keeps pillar
 * outlines convex polygons and makes the swept test exact.
 *
 * @param {{x: number, y: number}} from Body centre at the start of the tick.
 * @param {{x: number, y: number}} motion Centre displacement relative to the obstacles.
 * @param {number} pitch Body tilt in radians.
 * @param {Iterable<{x: number, gapY: number, gapHeight: number, halfWidth: number}>} obstacles
 * @returns {{time: number, x: number, y: number, solid: 'floor'|'ceiling'|'pillar'} | null}
 *   `time` is the fraction of the tick in [0, 1] at the first contact, `(x, y)` the touched
 *   point in the same frame as `from`, or null when the body touches nothing.
 */
export function sweepBody(from, motion, pitch, obstacles) {
  const a = BAT_HALF_WIDTH, b = BAT_HALF_HEIGHT, r = 1 + CONTACT_TOLERANCE;
  const c = Math.cos(pitch), s = Math.sin(pitch);
  const ext = bodyExtents(pitch);
  let best = null;
  const keep = (time, x, y, solid) => {
    if (time !== null && (best === null || time < best.time)) best = { time, x, y, solid };
  };
  const centreAt = (t) => [from.x + motion.x * t, from.y + motion.y * t];

  // Cave surfaces: the lowest and highest points of the body move in straight lines.
  const reach = ext.halfHeight * r;
  const floorTime = surfaceEntry(from.y - CAVE_FLOOR, -motion.y, reach);
  if (floorTime !== null) keep(floorTime, centreAt(floorTime)[0] + supportX(0, -1, c, s), CAVE_FLOOR, 'floor');
  const ceilingTime = surfaceEntry(CAVE_CEILING - from.y, motion.y, reach);
  if (ceilingTime !== null) keep(ceilingTime, centreAt(ceilingTime)[0] + supportX(0, 1, c, s), CAVE_CEILING, 'ceiling');

  // Pillars, in body space: rotate by -pitch and divide by the semi-axes, so the body is a disk.
  const toBody = (x, y) => {
    const dx = x - from.x, dy = y - from.y;
    return [(dx * c + dy * s) / a, (-dx * s + dy * c) / b];
  };
  const [mx, my] = toBody(from.x + motion.x, from.y + motion.y);
  const margin = 1e-6; // keeps the box rejection looser than the contact tolerance
  const minX = Math.min(from.x, from.x + motion.x) - ext.halfWidth - margin;
  const maxX = Math.max(from.x, from.x + motion.x) + ext.halfWidth + margin;
  const minY = Math.min(from.y, from.y + motion.y) - ext.halfHeight - margin;
  const maxY = Math.max(from.y, from.y + motion.y) + ext.halfHeight + margin;
  for (const obstacle of obstacles) {
    if (obstacle.x + obstacle.halfWidth < minX || obstacle.x - obstacle.halfWidth > maxX) continue;
    for (const part of obstacleParts(obstacle)) {
      const low = Math.min(part.edgeY, part.rootY), high = Math.max(part.edgeY, part.rootY);
      if (high < minY || low > maxY) continue;
      const polygon = part.polygon.map(([x, y]) => toBody(x, y));
      const t = sweepDisk(mx, my, polygon, r);
      if (t === null || (best !== null && t >= best.time)) continue;
      const near = closestOnPolygon(mx * t, my * t, polygon);
      const lx = near.x * a, ly = near.y * b;
      keep(t, from.x + lx * c - ly * s, from.y + lx * s + ly * c, 'pillar');
    }
  }
  return best;
}

// x offset from the centre to the body point that reaches farthest in direction (ux, uy).
function supportX(ux, uy, c, s) {
  const wx = ux * c + uy * s, wy = -ux * s + uy * c; // direction in the body's own axes
  const px = BAT_HALF_WIDTH * wx, py = BAT_HALF_HEIGHT * wy, n = Math.hypot(px, py);
  const lx = BAT_HALF_WIDTH * px / n, ly = BAT_HALF_HEIGHT * py / n;
  return lx * c - ly * s;
}
