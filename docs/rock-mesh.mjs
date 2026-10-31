/* Flappy Bat rock meshes as plain vertex data, built from the collision outlines so the drawn
   play-plane boundary is the collision boundary. No DOM or THREE; main.js makes geometries. */
import { CAVE_CEILING, CAVE_FLOOR } from './game-rules.mjs';

const TAU = Math.PI * 2;

export const PILLAR_DEPTH = 0.5; // half depth of a pillar along z
const PILLAR_SIDES = 8; // section vertices; vertices 0 and 4 sit on the play plane
const PILLAR_RING_STEP = 0.8; // largest spacing of the section rings along a pillar
// Decoration stones keep at least this far inside the outline, which also covers the
// perspective shift of a stone on the front face of a pillar.
export const STONE_MARGIN = 0.2;

export const TUNNEL_SEGMENT_LENGTH = 8;
// The floor and the ceiling are flat on the cave surfaces from the play plane back to
// z = -CAVE_LIP_DEPTH, deeper than the bat body (0.35) and the pillars (PILLAR_DEPTH).
export const CAVE_LIP_DEPTH = 0.6;
// Toward the camera the rock turns away from the flight band at once: it slopes
// CAVE_RIM_SLOPE[1] over the first CAVE_RIM_SLOPE[0] in z, then drops CAVE_CLIFF. So the
// rim is a crease exactly on the play plane, and the cliff fills the screen below it.
const CAVE_RIM_SLOPE = [0.6, 0.25];
const CAVE_CLIFF = 12; // deeper than a tall phone screen shows
const CAVE_BACK = 5; // depth of the back wall behind the play plane
const CAVE_ARC_POINTS = 9;
const CAVE_PEBBLES = 3;

/**
 * Mesh of one pillar part from obstacleParts(), with x relative to the part's x.
 *
 * Each section ring is an octagon. Vertices 0 and 4 lie on the play plane (z = 0) at
 * x = ±halfWidth, and the others are jittered inward. At the gap edge the section narrows to a
 * ridge on the play plane, halfWidth - chamfer long, which also cuts the chamfer. So the slice
 * of the mesh at z = 0 is the part's outline, seen straight from the side no vertex is outside
 * the outline, and in perspective the end of the pillar still ends on the gap edge.
 *
 * @param {ReturnType<typeof import('./collision.mjs').obstacleParts>[number]} part
 * @param {() => number} random Returns numbers in [0, 1).
 * @returns {{positions: number[], indices: number[],
 *   stones: Array<{x: number, y: number, z: number, radius: number, scaleY: number, rotation: number[]}>}}
 *   Indexed triangles with outward winding, and decoration stones (scaled by `scaleY` along y,
 *   then rotated by the Euler angles `rotation`).
 */
export function pillarMesh(part, random) {
  const { halfWidth: w, chamfer: c, edgeY, rootY } = part;
  const dir = Math.sign(edgeY - rootY); // +1: the lower part, which grows up to the gap
  const shoulderY = edgeY - dir * c;
  // Rings as [y, x scale, depth scale]. The depth halves over the last two chamfer lengths
  // and reaches 0 at the ridge, so the back of the pillar stays behind the ridge on screen.
  const taperY = edgeY - dir * 2 * c;
  const steps = Math.max(1, Math.round(Math.abs(taperY - rootY) / PILLAR_RING_STEP));
  const rings = [];
  for (let i = 0; i <= steps; i++) rings.push([rootY + (taperY - rootY) * i / steps, 1, 1]);
  rings.push([shoulderY, 1, 0.5], [edgeY, (w - c) / w, 0]);

  const positions = [];
  for (const [y, scaleX, scaleZ] of rings) {
    for (let k = 0; k < PILLAR_SIDES; k++) {
      const angle = k / PILLAR_SIDES * TAU;
      if (k % (PILLAR_SIDES / 2) === 0) positions.push((k === 0 ? w : -w) * scaleX, y, 0);
      else if (scaleZ === 0) positions.push(Math.cos(angle) * w * scaleX, y, 0);
      else {
        positions.push(
          Math.cos(angle) * w * scaleX * (0.8 + 0.2 * random()),
          y,
          Math.sin(angle) * PILLAR_DEPTH * scaleZ * (0.75 + 0.25 * random()),
        );
      }
    }
  }
  const indices = [];
  const tri = (a, b, e) => (dir > 0 ? indices.push(a, b, e) : indices.push(a, e, b));
  const n = PILLAR_SIDES;
  // Next to the ridge, split each quad along the diagonal that keeps both triangles off the play plane.
  const onPlane = (...v) => v.every((index) => positions[index * 3 + 2] === 0);
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < n; k++) {
      const a = i * n + k, b = i * n + (k + 1) % n;
      if (onPlane(a, a + n, b + n)) { tri(a, a + n, b); tri(b, a + n, b + n); }
      else { tri(a, b + n, b); tri(a, a + n, b + n); }
    }
  }
  const rootCentre = positions.push(0, rootY, 0) / 3 - 1;
  for (let k = 0; k < n; k++) tri(rootCentre, k, (k + 1) % n);

  // Stones sit on the front or back face, inside the visible part of the outline.
  const stones = [];
  const surface = dir > 0 ? CAVE_FLOOR : CAVE_CEILING;
  for (let i = 0; i < 3; i++) {
    const radius = 0.12 + 0.12 * random(), scaleY = 0.7 + 0.7 * random();
    const reach = radius * Math.max(1, scaleY) + STONE_MARGIN; // bounding radius plus margin
    const low = surface + dir * reach, high = shoulderY - dir * reach;
    const t = random(), side = random() < 0.5 ? -1 : 1, spread = random() * 2 - 1;
    const rotation = [random() * TAU, random() * TAU, random() * TAU];
    if ((high - low) * dir <= 0 || reach >= w) continue; // no room on this part
    // The stone reaches no farther from the play plane than the pillar's own faces, so in
    // perspective it never looks wider than the pillar.
    stones.push({ x: spread * (w - reach), y: low + (high - low) * t, z: side * (PILLAR_DEPTH - (reach - STONE_MARGIN)), radius, scaleY, rotation });
  }
  return { positions, indices, stones };
}

/**
 * Cross-sections of a ring of tunnel segments as [y, z] points. Segment i runs from section i
 * to section (i + 1) % count, so neighbouring segments share their end section and leave no
 * seams, also after the last segment moves to the front of the row.
 *
 * Each section runs from the floor cliff in front, over the floor rim at y = CAVE_FLOOR (z from
 * 0 back to -CAVE_LIP_DEPTH), along the back wall, to the ceiling rim at y = CAVE_CEILING and
 * the ceiling cliff. Rock jitter only moves points away from the flight band, so no rock reaches
 * into it on the play plane.
 *
 * @param {number} count Number of segments in the ring.
 * @param {() => number} random Returns numbers in [0, 1).
 * @returns {Array<Array<[number, number]>>}
 */
export function tunnelSections(count, random) {
  const midY = (CAVE_FLOOR + CAVE_CEILING) / 2, ry = (CAVE_CEILING - CAVE_FLOOR) / 2;
  const rz = CAVE_BACK - CAVE_LIP_DEPTH;
  const [slopeZ, slopeDrop] = CAVE_RIM_SLOPE;
  return Array.from({ length: count }, (_, i) => {
    const front = (surface, away) => [
      [surface + away * (CAVE_CLIFF + random()), slopeZ + 0.3 * random()],
      [surface + away * (slopeDrop + 0.1 * random()), slopeZ],
    ];
    const section = [...front(CAVE_FLOOR, -1), [CAVE_FLOOR, 0], [CAVE_FLOOR, -CAVE_LIP_DEPTH]];
    for (let j = 1; j <= CAVE_ARC_POINTS; j++) {
      const angle = Math.PI * (1 - j / (CAVE_ARC_POINTS + 1)); // from the floor (π) to the ceiling (0)
      const out = 1 + 0.08 * random() + 0.04 * (1 + Math.sin(j * 2.1 + i));
      section.push([midY + ry * Math.cos(angle) * out, -CAVE_LIP_DEPTH - rz * Math.sin(angle) * out]);
    }
    section.push([CAVE_CEILING, -CAVE_LIP_DEPTH], [CAVE_CEILING, 0], ...front(CAVE_CEILING, 1).reverse());
    return section;
  });
}

/**
 * Mesh of one tunnel segment between two sections of tunnelSections(), centred on x = 0 and
 * TUNNEL_SEGMENT_LENGTH long.
 *
 * @param {Array<[number, number]>} left Section at x = -TUNNEL_SEGMENT_LENGTH / 2.
 * @param {Array<[number, number]>} right Section at x = TUNNEL_SEGMENT_LENGTH / 2.
 * @param {() => number} random Returns numbers in [0, 1).
 * @returns {{positions: number[], indices: number[], rimIndices: number[],
 *   pebbles: Array<{x: number, y: number, z: number, radius: number, rotation: number[]}>}}
 *   `indices` are the cave inside, `rimIndices` the faces in front of the play plane (rim slopes
 *   and cliffs), drawn darker so the rim crease on the play plane reads as the floor and ceiling
 *   edge. Pebbles are background rocks on the back wall, behind the floor and ceiling rims.
 */
export function tunnelSegmentMesh(left, right, random) {
  const positions = [];
  for (const [y, z] of left) positions.push(-TUNNEL_SEGMENT_LENGTH / 2, y, z);
  for (const [y, z] of right) positions.push(TUNNEL_SEGMENT_LENGTH / 2, y, z);
  const count = left.length, indices = [], rimIndices = [];
  for (let j = 0; j < count - 1; j++) {
    const front = left[j][1] > 0 || left[j + 1][1] > 0; // a face of the rim slope or the cliff
    (front ? rimIndices : indices).push(j, j + 1, count + j + 1, j, count + j + 1, count + j);
  }

  const midY = (CAVE_FLOOR + CAVE_CEILING) / 2, ry = (CAVE_CEILING - CAVE_FLOOR) / 2;
  const rz = CAVE_BACK - CAVE_LIP_DEPTH;
  const pebbles = [];
  for (let k = 0; k < CAVE_PEBBLES; k++) {
    const angle = 0.25 + (Math.PI - 0.5) * random(); // away from the floor and ceiling rims
    const out = 1.04 + 0.06 * random();
    pebbles.push({
      x: (random() * 2 - 1) * (TUNNEL_SEGMENT_LENGTH / 2 - 0.4),
      y: midY + ry * Math.cos(angle) * out,
      z: -CAVE_LIP_DEPTH - rz * Math.sin(angle) * out,
      radius: 0.12 + 0.21 * random(),
      rotation: [random() * TAU, random() * TAU, random() * TAU],
    });
  }
  return { positions, indices, rimIndices, pebbles };
}
