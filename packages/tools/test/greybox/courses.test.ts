import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  boxContents,
  buildBrush,
  buildCollisionWorld,
  CMAP_PREAMBLE_BYTES,
  CMAP_SECTION_ENTRY_BYTES,
  CMAP_TAG_VERTICES,
  type Cmap,
  CONTENTS_LADDER,
  CONTENTS_SOLID,
  CONTENTS_TRIGGER,
  CONTENTS_WATER,
  type CollisionWorld,
  decodeCmap,
  HULL_CROUCHED_MAXS,
  HULL_MINS,
  HULL_STANDING_MAXS,
  MASK_PLAYERSOLID,
  ORIGIN_LIMIT,
  pointContents,
  positionTest,
  SURF_LADDER,
  TRACE_EPSILON,
  TraceResult,
  traceBox,
  traceRay,
  type Vec3,
  vec3,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { encodeCmap } from "../../src/greybox/cmapEncode";
import { COURSE_MAP_DIR, COURSES, courseFileName } from "../../src/greybox/courses";
import { MATERIAL_FLOOR_ALT } from "../../src/greybox/courses/common";
import { MATERIAL_FLOOR } from "../../src/greybox/MapBuilder";
import { fromRoot } from "../../src/paths";

// docs/07 §3 and §6, M1 design I: the courses compile byte-identically, the committed
// content/maps files are current, and each course holds the fixtures it promises, checked
// through the loader (decodeCmap + buildCollisionWorld) and traces, with places named by anchors.

type P3 = readonly [number, number, number];

const SPAWN_CLASSES = ["info_player_start", "info_spawn_red", "info_spawn_blue"] as const;

function committedPath(name: string): string {
  return fromRoot(...COURSE_MAP_DIR, courseFileName(name));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

interface Loaded {
  readonly cmap: Cmap;
  readonly world: CollisionWorld;
}

const loaded = new Map<string, Loaded>();

/** The committed file, decoded with hash verification, as the game loads it. */
function load(name: string): Loaded {
  let l = loaded.get(name);
  if (l === undefined) {
    const cmap = decodeCmap(new Uint8Array(readFileSync(committedPath(name))));
    l = { cmap, world: buildCollisionWorld(cmap) };
    loaded.set(name, l);
  }
  return l;
}

function anchors(cmap: Cmap): Map<string, P3[]> {
  const out = new Map<string, P3[]>();
  for (const e of cmap.entities) {
    if (e.classname !== "info_target") continue;
    const name = e.props.targetname ?? "";
    const list = out.get(name) ?? [];
    if (e.origin !== undefined) list.push(e.origin);
    out.set(name, list);
  }
  return out;
}

function anchor(name: string, course: string): P3 {
  const list = anchors(load(course).cmap).get(name) ?? [];
  expect(list.length, `${course} anchor ${name}`).toBe(1);
  return list[0] as P3;
}

/** Where a player standing at an anchor settles: feet 1/32 u above the ground (D-017). */
function rest(p: P3, dx = 0, dy = 0, dz = 0): Vec3 {
  return vec3(p[0] + dx, p[1] + dy, p[2] + TRACE_EPSILON + dz);
}

function at(p: P3, dx = 0, dy = 0, dz = 0): Vec3 {
  return vec3(p[0] + dx, p[1] + dy, p[2] + dz);
}

function sweep(world: CollisionWorld, from: Vec3, to: Vec3, maxs: Vec3): TraceResult {
  const tr = new TraceResult();
  traceBox(world, from, to, HULL_MINS, maxs, MASK_PLAYERSOLID, tr);
  return tr;
}

function ray(world: CollisionWorld, from: Vec3, to: Vec3): TraceResult {
  const tr = new TraceResult();
  traceRay(world, from, to, MASK_PLAYERSOLID, tr);
  return tr;
}

/** The ground plane under a point: a ray from 64 u above to 2048 u below. */
function groundBelow(world: CollisionWorld, p: P3, dx = 0, dy = 0): TraceResult {
  const tr = ray(world, at(p, dx, dy, 64), at(p, dx, dy, -2048));
  expect(tr.fraction).toBeLessThan(1);
  return tr;
}

/** Height of the flat ground under a point. */
function groundZ(world: CollisionWorld, p: P3, dx = 0, dy = 0): number {
  const tr = groundBelow(world, p, dx, dy);
  expect([...tr.normal]).toEqual([0, 0, 1]);
  return tr.planeDist;
}

function groundMaterial(course: string, p: P3, dx = 0, dy = 0): string {
  const { cmap, world } = load(course);
  const tr = groundBelow(world, p, dx, dy);
  return cmap.materials[cmap.planeMaterial[tr.plane] ?? -1] ?? "?";
}

/**
 * Water level from samples at the feet, waist and eyes (docs/03 §3): feet + 1, half the standing
 * height (feet + 28) and the standing eye height (feet + 50, docs/03 §2). M2 pins the points.
 */
function waterLevel(world: CollisionWorld, origin: Vec3): number {
  const feet = origin[2] + HULL_MINS[2];
  let level = 0;
  for (const h of [1, 28, 50]) {
    const p = vec3(origin[0], origin[1], feet + h);
    if ((pointContents(world, p) & CONTENTS_WATER) === 0) break;
    level++;
  }
  return level;
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let x = from; x <= to; x += step) out.push(x);
  return out;
}

const EXPECTED_ANCHORS: Record<string, readonly string[]> = {
  movement_lab: [
    "runway_start",
    "runway_end",
    ...[16, 18, 19].flatMap((h) => [`step_${h}_base`, `step_${h}_top`]),
    "stairs_base",
    "stairs_top",
    ...["069", "071", "080"].flatMap((t) => [`slope_${t}_base`, `slope_${t}_top`]),
    "ladder_base",
    "ladder_top",
    "water_wade",
    "water_waist",
    "water_deep",
    "tunnel_entry",
    "tunnel_exit",
  ],
  jump_lab: [
    ...range(64, 320, 32).flatMap((g) => [`gap_${g}_takeoff`, `gap_${g}_landing`]),
    ...range(24, 120, 8).flatMap((h) => [`ledge_${h}_base`, `ledge_${h}_top`]),
    "chimney_base",
    "chimney_top",
    ...[15, 30, 45, 60].map((d) => `kick_${d}_takeoff`),
    "curb_base",
    "curb_top",
  ],
  slide_lab: [
    "stairs_base",
    "ramp_top",
    "lane_start",
    "lane_end",
    "door_entry",
    "door_exit",
    ...["41", "42", "44", "40_blocked"].flatMap((g) => [
      `slide_gap_${g}_entry`,
      `slide_gap_${g}_exit`,
    ]),
  ],
  fall_tower: [
    ...[128, 256, 384, 512, 640, 768, 1024].flatMap((h) => [
      `platform_${h}_top`,
      `platform_${h}_landing`,
    ]),
    "pool_landing",
    ...[256, 512, 768].flatMap((h) => [`rail_${h}_top`, `rail_${h}_drop`]),
  ],
  arena_greybox: [
    "red_door_inside",
    "red_door_outside",
    "blue_door_inside",
    "blue_door_outside",
    "center_top",
    "ramp_north_base",
    "ramp_south_base",
    "corridor_west",
    "corridor_east",
    "ledge_south_top",
  ],
};

describe("greybox courses: compiled files", () => {
  it("are listed in a fixed order with unique names", () => {
    expect(COURSES.map((c) => c.name)).toEqual([
      "movement_lab",
      "jump_lab",
      "slide_lab",
      "fall_tower",
      "arena_greybox",
    ]);
  });

  it("has one module per course and no other compiled map in content/maps", () => {
    const names = COURSES.map((c) => c.name).sort();
    const modules = readdirSync(fromRoot("packages", "tools", "src", "greybox", "courses"))
      .filter((f) => f.endsWith(".ts") && f !== "index.ts" && f !== "common.ts")
      .map((f) => f.slice(0, -3))
      .sort();
    expect(modules).toEqual(names);
    const maps = readdirSync(fromRoot(...COURSE_MAP_DIR))
      .filter((f) => f.endsWith(".cmap"))
      .sort();
    expect(maps).toEqual(names.map(courseFileName));
  });

  it.each(COURSES.map((c) => [c.name, c] as const))(
    "%s compiles byte-identically and matches content/maps",
    (name, course) => {
      const first = course.build();
      const bytes = encodeCmap(first);
      expect(first.name).toBe(name);
      expect(sameBytes(bytes, encodeCmap(course.build()))).toBe(true);
      expect(decodeCmap(bytes).contentHash).toBe(first.contentHash);
      const stale = `content/maps/${courseFileName(name)} is stale: run pnpm greybox and commit`;
      const path = committedPath(name);
      expect(existsSync(path), stale).toBe(true);
      expect(sameBytes(bytes, new Uint8Array(readFileSync(path))), stale).toBe(true);
    },
  );

  it.each(COURSES.map((c) => c.name))("%s decodes with its hash verified", (name) => {
    const bytes = new Uint8Array(readFileSync(committedPath(name)));
    expect(() => decodeCmap(bytes, { verifyHash: true })).not.toThrow();
    // One ulp off the first vertex's u: still a valid file, so only the hash can tell.
    const broken = bytes.slice();
    const view = new DataView(broken.buffer);
    let uv = -1;
    for (let s = 0; s < view.getUint32(12, true); s++) {
      const entry = CMAP_PREAMBLE_BYTES + CMAP_SECTION_ENTRY_BYTES * s;
      if (view.getUint32(entry, true) === CMAP_TAG_VERTICES)
        uv = view.getUint32(entry + 4, true) + 24;
    }
    expect(uv).toBeGreaterThan(0);
    broken[uv] = (broken[uv] as number) ^ 1;
    expect(() => decodeCmap(broken, { verifyHash: false })).not.toThrow();
    expect(() => decodeCmap(broken)).toThrow(/hash/i);
  });
});

describe.each(COURSES.map((c) => c.name))("greybox course %s: sanity", (name) => {
  it("every brush rebuilds from its faces to exactly the stored planes and bounds", () => {
    const { cmap, world } = load(name);
    const b = cmap.brushes;
    expect(world.brushCount).toBe(b.firstPlane.length);
    for (let i = 0; i < b.firstPlane.length; i++) {
      const first = b.firstPlane[i] as number;
      const faces = Float64Array.from(
        cmap.planes.subarray(4 * first, 4 * (first + (b.faceCount[i] as number))),
      );
      const built = buildBrush(faces, `${name} brush ${i}`);
      const stored = cmap.planes.subarray(4 * first, 4 * (first + (b.planeCount[i] as number)));
      expect(built.faceCount, `brush ${i}`).toBe(b.faceCount[i]);
      expect([...built.planes], `brush ${i}`).toEqual([...stored]);
      expect([...built.bounds], `brush ${i}`).toEqual([...b.bounds.subarray(6 * i, 6 * i + 6)]);
    }
  });

  it("bounds, brush bounds and entity origins are finite and within ±16384", () => {
    const { cmap } = load(name);
    const values = [
      ...cmap.bounds.mins,
      ...cmap.bounds.maxs,
      ...cmap.brushes.bounds,
      ...cmap.entities.flatMap((e) => e.origin ?? []),
    ];
    for (const v of values) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(ORIGIN_LIMIT);
    }
  });

  it("spawns and anchors are standing spots: hull clear, ground within 1 u", () => {
    const { cmap, world } = load(name);
    const spots = cmap.entities.filter(
      (e) =>
        e.classname === "info_target" || (SPAWN_CLASSES as readonly string[]).includes(e.classname),
    );
    expect(spots.some((e) => e.classname === "info_player_start")).toBe(true);
    for (const e of spots) {
      const label = `${e.classname} ${e.props.targetname ?? ""} at ${e.origin?.join(", ")}`;
      expect(e.origin, label).toBeDefined();
      const origin = at(e.origin as P3);
      expect(
        positionTest(world, origin, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID),
        label,
      ).toBe(true);
      const down = sweep(world, origin, at(e.origin as P3, 0, 0, -1), HULL_STANDING_MAXS);
      expect(down.startSolid, label).toBe(false);
      expect(down.fraction, label).toBeLessThan(1);
      expect(down.normal[2], label).toBeGreaterThanOrEqual(0.7);
    }
  });

  it("spawns of each class are at least 64 u apart", () => {
    const { cmap } = load(name);
    for (const cls of SPAWN_CLASSES) {
      const list = cmap.entities.filter((e) => e.classname === cls).map((e) => e.origin as P3);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i] as P3;
          const b = list[j] as P3;
          const d = Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
          expect(d, `${cls} ${i} and ${j}`).toBeGreaterThanOrEqual(64);
        }
      }
    }
  });

  it("every anchor the course promises exists exactly once, and no name repeats", () => {
    const found = anchors(load(name).cmap);
    for (const [anchorName, list] of found) expect(list.length, anchorName).toBe(1);
    expect([...found.keys()].sort()).toEqual([...(EXPECTED_ANCHORS[name] ?? [])].sort());
  });
});

describe("movement_lab fixtures", () => {
  const course = "movement_lab";

  it("has a clear 6144 × 6144 u floor with the runway on it", () => {
    const { world } = load(course);
    for (const [x, y] of [
      [-3056, -3056],
      [3056, 3056],
      [-3056, 3056],
      [3056, -3056],
    ] as const) {
      expect(groundZ(world, [x, y, 24])).toBe(0);
    }
    // Both diagonals cross every seam of both tile directions without a snag.
    for (const [a, b] of [
      [
        [-3040, -3040, 24],
        [3040, 3040, 24],
      ],
      [
        [-3040, 3040, 24],
        [3040, -3040, 24],
      ],
    ] as const) {
      const tr = sweep(world, rest(a), rest(b), HULL_STANDING_MAXS);
      expect(tr.startSolid).toBe(false);
      expect(tr.fraction).toBe(1);
    }
    const start = anchor("runway_start", course);
    const end = anchor("runway_end", course);
    expect(end[0] - start[0]).toBeGreaterThanOrEqual(1024);
    expect(sweep(world, rest(start), rest(end), HULL_STANDING_MAXS).fraction).toBe(1);
  });

  it("tiles the north half of the open floor in alternating 128 u strips along y", () => {
    for (let i = 0; i < 23; i++) {
      const a = groundMaterial(course, [0, 64 + 128 * i, 24]);
      const b = groundMaterial(course, [0, 192 + 128 * i, 24]);
      expect([a, b].sort(), `y ${64 + 128 * i}`).toEqual(
        [MATERIAL_FLOOR, MATERIAL_FLOOR_ALT].sort(),
      );
    }
  });

  it("marks the runway with alternating 128 u tiles", () => {
    const start = anchor("runway_start", course);
    for (let i = 0; i < 16; i++) {
      const a = groundMaterial(course, start, 128 * i + 64);
      const b = groundMaterial(course, start, 128 * i + 192);
      expect([a, b].sort()).toEqual([MATERIAL_FLOOR, MATERIAL_FLOOR_ALT].sort());
    }
  });

  it("times the runway with triggers 2048 u apart that a run between the anchors crosses", () => {
    const { cmap, world } = load(course);
    const start = anchor("runway_start", course);
    const end = anchor("runway_end", course);
    const bounds = (cls: string): number[] => {
      const timers = cmap.entities.filter((e) => e.classname === cls);
      expect(timers.length, cls).toBe(1);
      const brushes = timers[0]?.brushes ?? [];
      expect(brushes.length, cls).toBe(1);
      const b = brushes[0] as number;
      expect(cmap.brushes.contents[b]).toBe(CONTENTS_TRIGGER);
      return [...cmap.brushes.bounds.subarray(6 * b, 6 * b + 6)];
    };
    const on = bounds("info_timer_start");
    const off = bounds("info_timer_stop");
    // Matching faces 2048 u apart: entering both, or leaving both, times the same distance.
    expect((off[0] as number) - (on[0] as number)).toBe(2048);
    expect((off[3] as number) - (on[3] as number)).toBe(2048);
    for (const b of [on, off]) {
      expect(start[1]).toBeGreaterThan(b[1] as number);
      expect(start[1]).toBeLessThan(b[4] as number);
    }
    // The anchors stand outside the triggers, start west of the start line, end east of the stop.
    const hullContents = (p: P3): number => {
      const o = rest(p);
      return boxContents(
        world,
        vec3(o[0] - 16, o[1] - 16, o[2] - 24),
        vec3(o[0] + 16, o[1] + 16, o[2] + 32),
      );
    };
    expect(hullContents(start) & CONTENTS_TRIGGER).toBe(0);
    expect(hullContents(end) & CONTENTS_TRIGGER).toBe(0);
    expect(hullContents([0, start[1], start[2]]) & CONTENTS_TRIGGER).toBe(0);
    expect(start[0] + 16).toBeLessThan(on[0] as number);
    expect(end[0] - 16).toBeGreaterThan(off[3] as number);
  });

  it("has single steps of 16, 18 and 19 u", () => {
    const { world } = load(course);
    for (const h of [16, 18, 19]) {
      expect(groundZ(world, anchor(`step_${h}_top`, course))).toBe(h);
      expect(groundZ(world, anchor(`step_${h}_base`, course))).toBe(0);
    }
  });

  it("D-017: a step-up trace clears 16 and 18 u, not 19 u", () => {
    const { world } = load(course);
    for (const h of [16, 18, 19]) {
      const base = anchor(`step_${h}_base`, course);
      const up = sweep(world, rest(base), rest(base, 0, 0, 18), HULL_STANDING_MAXS);
      expect(up.fraction).toBe(1);
      const forward = sweep(world, rest(base, 0, 0, 18), rest(base, 0, 64, 18), HULL_STANDING_MAXS);
      if (h === 19) {
        expect(forward.fraction).toBeLessThan(1);
        expect([...forward.normal]).toEqual([0, -1, 0]);
        continue;
      }
      expect(forward.fraction).toBe(1);
      // Stepping down lands at once: the feet are 18 + 1/32 u up, so an 18 u step top is in the skin.
      const down = sweep(world, rest(base, 0, 64, 18), rest(base, 0, 64, 0), HULL_STANDING_MAXS);
      expect(down.fraction).toBeLessThan(1);
      if (h === 18) expect(down.endpos[2]).toBe(18 + base[2] + TRACE_EPSILON);
    }
  });

  it("has stairs up to a landing", () => {
    const { world } = load(course);
    expect(groundZ(world, anchor("stairs_top", course))).toBe(128);
  });

  it.each([
    ["069", 0.69, false],
    ["071", 0.71, true],
    ["080", 0.8, true],
  ] as const)("slope %s has normal z exactly fround(%d) (walkable: %s)", (tag, nz, walkable) => {
    const { world } = load(course);
    const base = anchor(`slope_${tag}_base`, course);
    const top = anchor(`slope_${tag}_top`, course);
    const mid: P3 = [base[0], (base[1] + top[1]) / 2, top[2]];
    const tr = groundBelow(world, mid);
    expect(tr.normal[2]).toBe(Math.fround(nz));
    expect(tr.normal[2] >= 0.7).toBe(walkable);
    // The crest platform has no lip: a hull at the platform's height moves from over the slope
    // onto it unhindered.
    const onto = sweep(world, rest(top, 0, -128), rest(top), HULL_STANDING_MAXS);
    expect(onto.startSolid).toBe(false);
    expect(onto.fraction).toBe(1);
  });

  it("has water levels 1, 2 and 3 in the wading, waist-deep and deep sections", () => {
    const { world } = load(course);
    expect(waterLevel(world, rest(anchor("water_wade", course)))).toBe(1);
    expect(waterLevel(world, rest(anchor("water_waist", course)))).toBe(2);
    expect(waterLevel(world, rest(anchor("water_deep", course)))).toBe(3);
    expect(groundZ(world, anchor("water_wade", course))).toBe(-12);
    expect(groundZ(world, anchor("water_waist", course))).toBe(-36);
    expect(groundZ(world, anchor("water_deep", course))).toBe(-128);
  });

  it("has a ladder: a LADDER volume in front of a SURF_LADDER wall face", () => {
    const { world } = load(course);
    const base = anchor("ladder_base", course);
    const o = rest(base);
    const mins = vec3(o[0] - 15, o[1] - 15, o[2] - 24);
    const maxs = vec3(o[0] + 15, o[1] + 15, o[2] + 32);
    expect(boxContents(world, mins, maxs) & CONTENTS_LADDER).toBe(CONTENTS_LADDER);
    const tr = ray(world, o, rest(base, 0, 64));
    expect(tr.fraction).toBeLessThan(1);
    expect([...tr.normal]).toEqual([0, -1, 0]);
    expect(tr.surfaceFlags & SURF_LADDER).toBe(SURF_LADDER);
    expect(tr.contents).toBe(CONTENTS_SOLID);
    expect(groundZ(world, anchor("ladder_top", course))).toBeGreaterThanOrEqual(256);
  });

  it("D-017: the 48 u tunnel passes a crouched hull at floor + 1/32 and blocks a standing one", () => {
    const { world } = load(course);
    const entry = anchor("tunnel_entry", course);
    const exit = anchor("tunnel_exit", course);
    const crouched = sweep(world, rest(entry), rest(exit), HULL_CROUCHED_MAXS);
    expect(crouched.startSolid).toBe(false);
    expect(crouched.fraction).toBe(1);
    const standing = sweep(world, rest(entry), rest(exit), HULL_STANDING_MAXS);
    expect(standing.fraction).toBeLessThan(1);
    const mid = rest(entry, (exit[0] - entry[0]) / 2);
    expect(positionTest(world, mid, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID)).toBe(false);
    expect(positionTest(world, mid, HULL_MINS, HULL_CROUCHED_MAXS, MASK_PLAYERSOLID)).toBe(true);
    const roof = ray(world, mid, rest(entry, (exit[0] - entry[0]) / 2, 0, 256));
    expect(-roof.planeDist).toBe(48);
  });
});

describe("jump_lab fixtures", () => {
  const course = "jump_lab";

  it.each(range(64, 320, 32))("gap %d u: deck edge to landing edge, floor below", (gap) => {
    const { world } = load(course);
    const takeoff = anchor(`gap_${gap}_takeoff`, course);
    const landing = anchor(`gap_${gap}_landing`, course);
    const edge = takeoff[0] + 16;
    const across = ray(world, at(takeoff, 17, 0, -32), at(takeoff, 17 + 1024, 0, -32));
    expect([...across.normal]).toEqual([-1, 0, 0]);
    expect(-across.planeDist - edge).toBe(gap);
    expect(landing[0] - 16 - edge).toBe(gap);
    expect(groundZ(world, takeoff, 16 + gap / 2)).toBe(0);
    expect(groundZ(world, landing)).toBe(groundZ(world, takeoff));
  });

  it.each(range(24, 120, 8))("ledge %d u", (h) => {
    const { world } = load(course);
    expect(groundZ(world, anchor(`ledge_${h}_top`, course))).toBe(h);
    expect(groundZ(world, anchor(`ledge_${h}_base`, course))).toBe(0);
  });

  it("has a chimney: walls 64 u apart and 512 u tall", () => {
    const { world } = load(course);
    const base = anchor("chimney_base", course);
    // Both walls stand 64 u apart from the floor to just under 512 u, and neither goes higher.
    for (const dz of [0, 480]) {
      const north = ray(world, at(base, 0, 0, dz), at(base, 0, 256, dz));
      const south = ray(world, at(base, 0, 0, dz), at(base, 0, -256, dz));
      expect(north.fraction, `${dz}`).toBeLessThan(1);
      expect(south.fraction, `${dz}`).toBeLessThan(1);
      expect(north.planeDist + south.planeDist).toBe(-64);
      expect(north.normal[1] + south.normal[1]).toBe(0);
    }
    expect(ray(world, at(base, 0, 0, 496), at(base, 0, 256, 496)).fraction).toBe(1);
    expect(ray(world, at(base, 0, 0, 496), at(base, 0, -256, 496)).fraction).toBe(1);
    expect(groundZ(world, anchor("chimney_top", course))).toBe(512);
  });

  it.each([
    [15, (Math.sqrt(6) + Math.sqrt(2)) / 4, (Math.sqrt(6) - Math.sqrt(2)) / 4],
    [30, Math.sqrt(3) / 2, 0.5],
    [45, Math.SQRT1_2, Math.SQRT1_2],
    [60, 0.5, Math.sqrt(3) / 2],
  ])("kick lane %d°: a free-standing wall facing the take-off, at least 64 u tall", (deg, c, s) => {
    const { world } = load(course);
    const takeoff = anchor(`kick_${deg}_takeoff`, course);
    for (const dz of [-16, 40]) {
      const tr = ray(world, at(takeoff, 0, 0, dz), at(takeoff, 128 * s, -128 * c, dz));
      expect(tr.fraction, `${dz}`).toBeLessThan(1);
      expect(tr.normal[0]).toBeCloseTo(-s, 6);
      expect(tr.normal[1]).toBeCloseTo(c, 6);
      expect(tr.normal[2]).toBe(0);
    }
    // The wall's brush runs from 16 u under the floor top to 240 u above it.
    const { cmap } = load(course);
    const cx = takeoff[0] + 64 * s;
    const cy = takeoff[1] - 64 * c;
    const walls: number[] = [];
    for (let b = 0; b < cmap.brushes.firstPlane.length; b++) {
      const bb = cmap.brushes.bounds.subarray(6 * b, 6 * b + 6);
      const inside =
        (bb[0] as number) < cx &&
        cx < (bb[3] as number) &&
        (bb[1] as number) < cy &&
        cy < (bb[4] as number);
      if (inside && (bb[5] as number) > 0) walls.push(b);
    }
    expect(walls.length).toBe(1);
    const wb = walls[0] as number;
    expect(cmap.brushes.bounds[6 * wb + 2]).toBe(-16);
    expect(cmap.brushes.bounds[6 * wb + 5]).toBe(240);
    // Over the top there is nothing: the wall stands alone below 256 u.
    expect(ray(world, at(takeoff, 0, 0, 240), at(takeoff, 128 * s, -128 * c, 240)).fraction).toBe(
      1,
    );
  });

  it("has a 24 u curb, too low to kick off", () => {
    const { world } = load(course);
    expect(groundZ(world, anchor("curb_top", course))).toBe(24);
    const base = anchor("curb_base", course);
    expect(ray(world, at(base, 0, 0, -23), at(base, 0, 128, -23)).fraction).toBeLessThan(1);
    expect(ray(world, at(base, 0, 0, 1), at(base, 0, 128, 1)).fraction).toBe(1);
  });
});

describe("slide_lab fixtures", () => {
  const course = "slide_lab";

  it.each([
    ["41", true],
    ["42", true],
    ["44", true],
    ["40_blocked", false],
  ] as const)("D-017: slide gap %s passes a crouched hull at floor + 1/32: %s", (gap, passes) => {
    const { world } = load(course);
    const entry = anchor(`slide_gap_${gap}_entry`, course);
    const exit = anchor(`slide_gap_${gap}_exit`, course);
    const height = Number.parseInt(gap, 10);
    const mid = rest(entry, (exit[0] - entry[0]) / 2);
    expect(-ray(world, mid, rest(entry, (exit[0] - entry[0]) / 2, 0, 256)).planeDist).toBe(height);
    const crouched = sweep(world, rest(entry), rest(exit), HULL_CROUCHED_MAXS);
    expect(crouched.startSolid).toBe(false);
    if (passes) {
      expect(crouched.fraction).toBe(1);
    } else {
      expect(crouched.fraction).toBeLessThan(1);
      expect([...crouched.normal]).toEqual([-1, 0, 0]);
    }
    expect(sweep(world, rest(entry), rest(exit), HULL_STANDING_MAXS).fraction).toBeLessThan(1);
  });

  it("has door frames 48 u wide and 96 u tall that a standing hull walks through", () => {
    const { world } = load(course);
    const entry = anchor("door_entry", course);
    const exit = anchor("door_exit", course);
    expect(sweep(world, rest(entry), rest(exit), HULL_STANDING_MAXS).fraction).toBe(1);
    for (const x of [512 + 8, 1024 + 8]) {
      const centre: P3 = [x, entry[1], 24];
      const left = ray(world, at(centre), at(centre, 0, 256));
      const right = ray(world, at(centre), at(centre, 0, -256));
      expect(-left.planeDist - right.planeDist).toBe(48);
      expect(-ray(world, at(centre), at(centre, 0, 0, 256)).planeDist).toBe(96);
    }
  });

  it("has a ramp into a long lane with alternating 128 u marker tiles", () => {
    const { world } = load(course);
    const top = anchor("ramp_top", course);
    const start = anchor("lane_start", course);
    const end = anchor("lane_end", course);
    expect(groundZ(world, top)).toBe(64);
    const slope = groundBelow(world, top, (start[0] - top[0]) / 2);
    expect(slope.normal[2]).toBeGreaterThan(0.7);
    expect(slope.normal[2]).toBeLessThan(1);
    expect(end[0] - start[0]).toBeGreaterThanOrEqual(4000);
    expect(sweep(world, rest(start), rest(end), HULL_CROUCHED_MAXS).fraction).toBe(1);
    for (let i = 0; i < 31; i++) {
      const a = groundMaterial(course, start, 32 + 128 * i);
      const b = groundMaterial(course, start, 160 + 128 * i);
      expect([a, b].sort()).toEqual([MATERIAL_FLOOR, MATERIAL_FLOOR_ALT].sort());
    }
  });
});

describe("fall_tower fixtures", () => {
  const course = "fall_tower";

  it.each([128, 256, 384, 512, 640, 768, 1024])("platform %d u above the floor", (h) => {
    const { world } = load(course);
    const top = anchor(`platform_${h}_top`, course);
    expect(groundZ(world, top)).toBe(h);
    expect(groundZ(world, anchor(`platform_${h}_landing`, course))).toBe(0);
    // A ladder up the back, and nothing between the south edge and the floor.
    const back = ray(world, at(top, 0, 128, -h), at(top, 0, 0, -h));
    expect(back.surfaceFlags & SURF_LADDER).toBe(SURF_LADDER);
    const drop = sweep(world, rest(top, 0, -96), rest(top, 0, -96, -h), HULL_STANDING_MAXS);
    expect(drop.endpos[2]).toBe(24 + TRACE_EPSILON);
  });

  it("has a 128 u deep water landing pool beside the 1024 u platform", () => {
    const { world } = load(course);
    const landing = anchor("pool_landing", course);
    expect(groundZ(world, landing)).toBe(-128);
    expect(waterLevel(world, rest(landing))).toBe(3);
    const top = anchor("platform_1024_top", course);
    // Stepping east off the top drops straight into the pool, deep enough to submerge.
    const dive = sweep(world, rest(top, 128), rest(top, 128, 0, -1088), HULL_STANDING_MAXS);
    expect(dive.fraction).toBe(1);
    expect(waterLevel(world, rest(top, 128, 0, -1088))).toBe(3);
  });

  it.each([256, 512, 768])(
    "has a catch rail at %d u under a clear drop, with a face a chest probe cannot skip",
    (h) => {
      const { world } = load(course);
      const rail = anchor(`rail_${h}_top`, course);
      const drop = anchor(`rail_${h}_drop`, course);
      expect(groundZ(world, rail)).toBe(h);
      expect(groundZ(world, drop)).toBe(1024);
      expect(positionTest(world, rest(rail), HULL_MINS, HULL_CROUCHED_MAXS, MASK_PLAYERSOLID)).toBe(
        true,
      );
      // Nothing between the wall top and this rail: a hull falling over it from the top lands on
      // it, a drop of 1024 − h u (768 u onto rail_256, docs/03 §8 MV-13).
      const fall = sweep(world, rest(rail, 0, 0, 1024 - h + 64), rest(rail), HULL_STANDING_MAXS);
      expect(fall.startSolid).toBe(false);
      expect(fall.fraction).toBe(1);
      expect(drop[0]).toBe(rail[0]);
      // The face is solid wherever the chest probe (feet + 40) sees a rail top 24…76 u above the
      // feet (docs/03 §5.5): chest heights h − 36 … h, more than a tick of fall at ~1110 u/s.
      for (let z = h - 36; z < h; z += 4) {
        const face = ray(world, vec3(rail[0], -64, z), vec3(rail[0], 0, z));
        expect(face.fraction, `${z}`).toBeLessThan(1);
        expect([...face.normal]).toEqual([0, -1, 0]);
        expect(-face.planeDist).toBe(-32);
      }
    },
  );
});

describe("arena_greybox fixtures", () => {
  const course = "arena_greybox";

  it("has 16 info_player_start, 8 info_spawn_red and 8 info_spawn_blue", () => {
    const { cmap } = load(course);
    const count = (cls: string) => cmap.entities.filter((e) => e.classname === cls).length;
    expect(count("info_player_start")).toBe(16);
    expect(count("info_spawn_red")).toBe(8);
    expect(count("info_spawn_blue")).toBe(8);
  });

  it.each(["red", "blue"])("the %s base door is at least 48 × 96 u and walkable", (team) => {
    const { world } = load(course);
    const inside = anchor(`${team}_door_inside`, course);
    const outside = anchor(`${team}_door_outside`, course);
    expect(sweep(world, rest(inside), rest(outside), HULL_STANDING_MAXS).fraction).toBe(1);
    const centre: P3 = [(inside[0] + outside[0]) / 2, inside[1], 24];
    const wall = ray(world, at(centre, 0, 256), at(centre, 0, -256));
    expect(wall.startSolid).toBe(true);
    const left = ray(world, at(centre, 0, 0, -23), at(centre, 0, 512, -23));
    const right = ray(world, at(centre, 0, 0, -23), at(centre, 0, -512, -23));
    expect(-left.planeDist - right.planeDist).toBeGreaterThanOrEqual(48);
    expect(-ray(world, at(centre), at(centre, 0, 0, 512)).planeDist).toBeGreaterThanOrEqual(96);
  });

  it("has a covered corridor at least 64 u wide", () => {
    const { world } = load(course);
    const west = anchor("corridor_west", course);
    const east = anchor("corridor_east", course);
    expect(sweep(world, rest(west), rest(east), HULL_STANDING_MAXS).fraction).toBe(1);
    const left = ray(world, at(west), at(west, 0, 512));
    const right = ray(world, at(west), at(west, 0, -512));
    expect(-left.planeDist - right.planeDist).toBeGreaterThanOrEqual(64);
    expect(ray(world, at(west), at(west, 0, 0, 512)).fraction).toBeLessThan(1);
  });

  it("puts each team's spawns inside its own base", () => {
    const { cmap } = load(course);
    const redDoor = anchor("red_door_inside", course);
    const blueDoor = anchor("blue_door_inside", course);
    expect(redDoor[0]).toBeLessThan(blueDoor[0]);
    for (const e of cmap.entities) {
      const o = e.origin as P3;
      if (e.classname === "info_spawn_red") expect(o[0]).toBeLessThanOrEqual(redDoor[0]);
      if (e.classname === "info_spawn_blue") expect(o[0]).toBeGreaterThanOrEqual(blueDoor[0]);
    }
  });

  it.each([
    ["ramp_north_base", 1],
    ["ramp_south_base", -1],
  ] as const)("leaves at least 64 u clear in front of %s", (name, dir) => {
    const { world } = load(course);
    const base = anchor(name, course);
    // The anchor stands 24 u past the foot; 64 u past the foot plus a hull half-width is clear.
    const tr = sweep(world, rest(base), rest(base, 0, dir * (64 - 24 + 16)), HULL_STANDING_MAXS);
    expect(tr.startSolid).toBe(false);
    expect(tr.fraction).toBe(1);
  });

  it.each([
    [-896, 0, 1, 0, 160],
    [896, 0, -1, 0, 160],
    [-384, 384, -1, 0, 160],
    [384, 384, 1, 0, 160],
    [-384, -384, 0, -1, 320],
    [384, -384, 0, -1, 320],
  ] as const)("has low cover in front of the spawn at (%d, %d)", (x, y, dx, dy, reach) => {
    const { world } = load(course);
    const o: P3 = [x, y, 24];
    // Blocked at the standing origin's height, open 48 u higher: cover to crouch behind.
    const low = ray(world, at(o), at(o, reach * dx, reach * dy));
    expect(low.fraction).toBeLessThan(1);
    expect(low.normal[2]).toBe(0);
    expect(ray(world, at(o, 0, 0, 48), at(o, reach * dx, reach * dy, 48)).fraction).toBe(1);
  });

  it("has verticality: a 128 u centre platform and a 96 u ledge", () => {
    const { world } = load(course);
    expect(groundZ(world, anchor("center_top", course))).toBe(128);
    expect(groundZ(world, anchor("ledge_south_top", course))).toBe(96);
    expect(groundZ(world, anchor("ramp_north_base", course))).toBe(0);
  });
});
