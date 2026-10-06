import {
  boxPlanes,
  buildBrush,
  CONTENTS_PLAYERCLIP,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  type CollisionBrushSource,
  type CollisionWorld,
  createCollisionWorld,
  FOOTSTEP_METAL,
  HULL_CROUCHED_MAXS,
  HULL_MINS,
  HULL_STANDING_MAXS,
  MASK_PLAYERSOLID,
  MASK_SOLID,
  MASK_WATER,
  Mulberry32,
  pointContents,
  rotatedBoxPlanes,
  SURF_SLICK,
  snapOrigin,
  surfaceWithFootstep,
  TRACE_EPSILON,
  TraceResult,
  traceBox,
  type Vec3,
  vec3,
  wedgePlanes,
} from "@game/shared";
import { brushRow, f64Hex, section, u32Hex } from "./rows";

/**
 * Renders packages/shared/test/vectors/trace.ts: a small fixed brush world as raw plane bits, and
 * input bits → output bits for traceBox, snapOrigin and pointContents on it. shared's test
 * rebuilds the world from the frozen planes (not from the polygonizer) and recomputes every row;
 * M2 replays the same file in real browsers.
 */
export const TRACE_VECTORS_FILE = ["packages", "shared", "test", "vectors", "trace.ts"];

function solid(planes: Float64Array, contents = CONTENTS_SOLID, topSurf = 0): CollisionBrushSource {
  const b = buildBrush(planes);
  const surf = new Array<number>(b.planes.length / 4).fill(0);
  // Box faces are ordered −x, +x, −y, +y, −z, +z, so face 5 is the top.
  if (topSurf !== 0) surf[5] = topSurf;
  return {
    planes: b.planes,
    faceCount: b.faceCount,
    bounds: b.bounds,
    contents,
    surfaceFlags: surf,
  };
}

/** Every M1 shape kind, abutting and overlapping pairs, water and player clip. */
function traceWorldBrushes(): CollisionBrushSource[] {
  const sin15 = (Math.sqrt(6) - Math.SQRT2) / 4;
  const cos15 = (Math.sqrt(6) + Math.SQRT2) / 4;
  return [
    solid(
      boxPlanes([-512, -512, -64], [512, 512, 0]),
      CONTENTS_SOLID,
      surfaceWithFootstep(SURF_SLICK, FOOTSTEP_METAL),
    ),
    solid(rotatedBoxPlanes([64, 160, 64], [128, 16, 64], Math.sqrt(3) / 2, 0.5)),
    solid(wedgePlanes([-320, -128, 0], [-128, 128, 96], "+x")),
    solid(boxPlanes([-128, -128, 0], [128, -32, 48]), CONTENTS_WATER),
    solid(boxPlanes([200, -64, 0], [264, 64, 128]), CONTENTS_PLAYERCLIP),
    solid(boxPlanes([264, -64, 0], [328, 64, 64])),
    solid(rotatedBoxPlanes([-160, 260, 128], [96, 8, 128], cos15, sin15)),
    // A 41 u slide gap.
    solid(boxPlanes([-40, -300, 41], [40, -220, 105])),
  ];
}

interface TraceCase {
  start: Vec3;
  end: Vec3;
  mins: Vec3;
  maxs: Vec3;
  mask: number;
}

const ZERO = vec3();
const LOPSIDED_MINS = vec3(-3, -7.5, -2);
const LOPSIDED_MAXS = vec3(5, 1, 9.25);
const HULLS: readonly (readonly [Vec3, Vec3])[] = [
  [HULL_MINS, HULL_STANDING_MAXS],
  [HULL_MINS, HULL_CROUCHED_MAXS],
  [ZERO, ZERO],
  [LOPSIDED_MINS, LOPSIDED_MAXS],
];
const MASKS = [MASK_PLAYERSOLID, MASK_SOLID, MASK_WATER, 0xffffffff];

function traceCases(world: CollisionWorld): TraceCase[] {
  const rest = 24 + TRACE_EPSILON;
  const stand: [Vec3, Vec3] = [HULL_MINS, HULL_STANDING_MAXS];
  const crouch: [Vec3, Vec3] = [HULL_MINS, HULL_CROUCHED_MAXS];
  const c = (
    s: [number, number, number],
    e: [number, number, number],
    hull: readonly [Vec3, Vec3] = stand,
    mask = MASK_PLAYERSOLID,
  ): TraceCase => ({ start: vec3(...s), end: vec3(...e), mins: hull[0], maxs: hull[1], mask });
  const cases = [
    // Rests on the floor, falling a dyadic and a non-dyadic distance.
    c([0, 0, 88], [0, 0, -40]),
    c([10.3, -7.7, 100], [10.3, -7.7, 0]),
    // Touching, skin and inward-from-skin slides on the floor.
    c([-100, 0, 24], [100, 37, 24]),
    c([-100, 0, 24 + 1 / 64], [100, 37, 24 + 1 / 64]),
    c([0, 0, 24 + 1 / 64], [5, 0, 14]),
    c([0, 0, rest], [0, 0, rest]),
    c([0, 0, 23], [0, 0, 23]),
    // Start solid moving out, all solid.
    c([0, 0, -30], [0, 0, 100], [ZERO, ZERO]),
    c([0, 0, -30], [10, 0, -31], [ZERO, ZERO]),
    // Ramp crest (the +z bevel) and the slope face.
    c([-118, 0, 160], [-118, 0, 80]),
    c([-224, 0, 200], [-224, 0, 0]),
    // The 30° box face and the 15° lane.
    c([-36, 333.2, 64], [64, 160, 64]),
    c([-160, 400, 128], [-160, 100, 128]),
    // Water and player clip under each mask.
    c([0, -80, 60], [0, -80, -10], stand, MASK_WATER),
    c([0, -80, 30], [0, -80, 200], stand, MASK_WATER),
    c([100, 0, 60], [400, 0, 60]),
    c([100, 0, 60], [400, 0, 60], stand, MASK_SOLID),
    // The 41 u gap: crouched passes from floor + 1/32, standing is blocked.
    c([0, -400, rest], [0, -100, rest], crouch),
    c([0, -400, rest], [0, -100, rest], stand),
    // A ray parallel to the floor, inside the skin, and exactly on it.
    c([-300, 400, 1 / 64], [300, 400, 1 / 64], [ZERO, ZERO]),
    c([-300, 400, 0], [300, 400, 0], [ZERO, ZERO]),
  ];
  const rng = new Mulberry32(0x7ace);
  const r = (range: number) => (rng.nextFloat() * 2 - 1) * range;
  for (let i = 0; i < 160; i++) {
    const hull = HULLS[i % HULLS.length] as readonly [Vec3, Vec3];
    const mask = MASKS[(i >>> 2) % MASKS.length] as number;
    const onGrid = rng.nextFloat() < 0.6;
    const g = (x: number) => (onGrid ? Math.round(x * 32) / 32 : x);
    // Mostly near a brush (inside its bounds grown by 48 u), so most cases touch geometry.
    const b = rng.nextInt(world.brushCount + 2);
    const start = vec3(g(r(400)), g(r(400)), g(24 + rng.nextFloat() * 160));
    if (b < world.brushCount) {
      for (let k = 0; k < 3; k++) {
        const lo = (world.brushBounds[6 * b + k] as number) - 48;
        const hi = (world.brushBounds[6 * b + k + 3] as number) + 48;
        start[k] = g(lo + rng.nextFloat() * (hi - lo));
      }
      if (b === 0) start[2] = g(24 + rng.nextFloat() * 8);
    }
    const length = [0, 0.25, 6, 18, 64, 400][rng.nextInt(6)] as number;
    const dir = vec3(r(1), r(1), r(1));
    if (i % 7 === 0) dir[2] = 0;
    const len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]) || 1;
    const end = vec3(
      start[0] + (dir[0] / len) * length,
      start[1] + (dir[1] / len) * length,
      start[2] + (dir[2] / len) * length,
    );
    cases.push({ start, end, mins: hull[0], maxs: hull[1], mask });
  }
  return cases;
}

function traceRow(world: CollisionWorld, t: TraceCase): string {
  const out = new TraceResult();
  traceBox(world, t.start, t.end, t.mins, t.maxs, t.mask, out);
  return [
    ...[...t.start, ...t.end, ...t.mins, ...t.maxs].map(f64Hex),
    u32Hex(t.mask),
    ...[out.fraction, ...out.endpos, ...out.normal, out.planeDist].map(f64Hex),
    out.plane,
    out.brush,
    out.contents,
    out.surfaceFlags,
    out.entity,
    out.startSolid ? 1 : 0,
    out.allSolid ? 1 : 0,
  ].join(" ");
}

/** Snaps every hit's endpos back onto the grid, with the trace start as last tick's origin. */
function snapRows(world: CollisionWorld, cases: TraceCase[]): string[] {
  const out = new TraceResult();
  const snapped = vec3();
  const rows: string[] = [];
  for (const t of cases) {
    traceBox(world, t.start, t.end, t.mins, t.maxs, t.mask, out);
    if (out.fraction === 1 || out.startSolid) continue;
    const rule = snapOrigin(world, out.endpos, t.mins, t.maxs, t.mask, t.start, snapped);
    rows.push(
      [
        ...[...out.endpos, ...t.mins, ...t.maxs].map(f64Hex),
        u32Hex(t.mask),
        ...[...t.start].map(f64Hex),
        rule,
        ...[...snapped].map(f64Hex),
      ].join(" "),
    );
  }
  return rows;
}

/**
 * Slide chains along a sloped and a rotated face (as in snapOrigin.test.ts), keeping every snap
 * that needed a cell corner plus the first few plain ones, so rule 2 has rows too.
 */
function slideSnapRows(world: CollisionWorld): string[] {
  const out = new TraceResult();
  const origin = vec3();
  const target = vec3();
  const rows: string[] = [];
  const rng = new Mulberry32(0x5a1d);
  // [brush, face, a clear point in front of that face].
  const surfaces: [number, number, Vec3][] = [
    [2, 4, vec3(-224, 0, 120)],
    [6, 3, vec3(-190, 330, 128)],
  ];
  for (const [b, face, approach] of surfaces) {
    const plane = (world.brushPlaneStart[b] as number) + face;
    const n = vec3(
      world.planes[4 * plane] as number,
      world.planes[4 * plane + 1] as number,
      world.planes[4 * plane + 2] as number,
    );
    const t1 = n[2] === 0 ? vec3(n[1], -n[0], 0) : vec3(n[2], 0, -n[0]);
    const t2 = n[2] === 0 ? vec3(0, 0, 1) : vec3(0, 1, 0);
    const down = vec3(approach[0] - n[0] * 200, approach[1] - n[1] * 200, approach[2] - n[2] * 200);
    traceBox(world, approach, down, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID, out);
    snapOrigin(
      world,
      out.endpos,
      HULL_MINS,
      HULL_STANDING_MAXS,
      MASK_PLAYERSOLID,
      approach,
      origin,
    );
    let plain = 0;
    for (let tick = 0; tick < 120; tick++) {
      // Back and forth along the face, so the box stays on it.
      const a1 = (tick % 20 < 10 ? 1 : -1) * rng.nextFloat() * 3;
      const a2 = (tick % 14 < 7 ? 1 : -1) * rng.nextFloat() * 3;
      const push = tick % 3 === 0 ? rng.nextFloat() * 0.5 : 0;
      for (let k = 0; k < 3; k++) {
        target[k] =
          (origin[k] as number) +
          a1 * (t1[k] as number) +
          a2 * (t2[k] as number) -
          push * (n[k] as number);
      }
      traceBox(world, origin, target, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID, out);
      const prev = vec3(origin[0], origin[1], origin[2]);
      const rule = snapOrigin(
        world,
        out.endpos,
        HULL_MINS,
        HULL_STANDING_MAXS,
        MASK_PLAYERSOLID,
        prev,
        origin,
      );
      if (rule === 0 && plain++ >= 4) continue;
      rows.push(
        [
          ...[...out.endpos, ...HULL_MINS, ...HULL_STANDING_MAXS].map(f64Hex),
          u32Hex(MASK_PLAYERSOLID),
          ...[...prev].map(f64Hex),
          rule,
          ...[...origin].map(f64Hex),
        ].join(" "),
      );
    }
  }
  return rows;
}

function pointRows(world: CollisionWorld): string[] {
  const points: [number, number, number][] = [
    [0, 0, 0],
    [0, 0, -1],
    [0, -80, 20],
    [0, -80, 48],
    [0, -32, 20],
    [230, 0, 64],
    [264, 0, 32],
    [-200, 0, 30],
  ];
  const rng = new Mulberry32(0x9c0);
  for (let i = 0; i < 24; i++) {
    points.push([
      (rng.nextFloat() * 2 - 1) * 350,
      (rng.nextFloat() * 2 - 1) * 350,
      rng.nextFloat() * 140 - 10,
    ]);
  }
  return points.map((p) => [...p.map(f64Hex), pointContents(world, vec3(...p))].join(" "));
}

export function renderTraceVectors(): string {
  const brushes = traceWorldBrushes();
  const world = createCollisionWorld(brushes);
  const cases = traceCases(world);
  return [
    "// GENERATED by packages/tools/src/vectors/trace.ts. Do not edit by hand.",
    "// Regenerate with `pnpm --filter @game/tools vectors`. A diff here means traces changed",
    "// bits: say why in the change (D-016, D-017).",
    "//",
    "// Frozen input → output bits for brush traces on a small fixed world. Fields as in",
    "// determinism.ts: f64 as 16 hex digits of the IEEE-754 bits, u32 as 8 hex digits, small",
    "// integers and booleans (0/1) in decimal. Plain JavaScript (no imports, no type annotations),",
    "// so M2 can load it in real browsers as is.",
    "",
    section(
      "TRACE_WORLD",
      "One brush per row: contents, faceCount, planeCount (decimal), bounds (6 f64), planes (nx ny nz d per plane, f64), surface flags per plane (u32)",
      brushes.map(brushRow),
    ),
    section(
      "TRACE_VECTORS",
      "start, end, mins, maxs (f64), mask (u32), then traceBox's fraction, endpos, normal, planeDist (f64), plane, brush, contents, surfaceFlags, entity, startSolid, allSolid (decimal)",
      cases.map((t) => traceRow(world, t)),
    ),
    section(
      "SNAP_VECTORS",
      "exact, mins, maxs (f64), mask (u32), prevOrigin (f64), then snapOrigin's rule (decimal) and out (f64)",
      [...snapRows(world, cases), ...slideSnapRows(world)],
    ),
    section("POINT_CONTENTS_VECTORS", "p (f64), pointContents(p) (decimal)", pointRows(world)),
  ].join("\n");
}
