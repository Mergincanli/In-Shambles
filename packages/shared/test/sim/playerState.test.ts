import { afterEach, describe, expect, it } from "vitest";
import { DevAssertError, setDevAsserts } from "../../src/debug/assert";
import { ORIGIN_LIMIT, VELOCITY_LIMIT } from "../../src/math/quant";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { ENTITY_NONE, ENTITY_WORLD } from "../../src/sim/entity";
import {
  ARMOR_HELMET,
  ARMOR_VEST,
  copyPlayerState,
  diffPlayerState,
  HEALTH_Q_MAX,
  PLAYER_HEALTH_MAX,
  PLAYER_STAMINA_FULL,
  PLAYER_STATE_RING_CAPACITY,
  PlayerState,
  PlayerStateRing,
  PMF_CLIMBING,
  PMF_CROUCH_PRESSED_IN_AIR,
  PMF_CROUCHED,
  PMF_GRAB_LOCK,
  PMF_GROUNDED,
  PMF_IN_WATER,
  PMF_JUMP_HELD,
  PMF_LEG_WOUND,
  PMF_LEGS_BROKEN,
  PMF_MASK,
  PMF_ON_LADDER,
  PMF_SLIDING,
  playerStateEquals,
  quantizePlayerState,
  resetPlayerStateForSpawn,
  WATER_LEVEL_MAX,
} from "../../src/sim/playerState";
import { TICK_MAX } from "../../src/time";

/** A state with every field away from its default. */
function sample(seed = 1): PlayerState {
  const ps = new PlayerState();
  ps.origin.set([100.5 + seed, -2.25, 64]);
  ps.velocity.set([320, -0.0625 * seed, 270]);
  ps.viewYaw = 16384 + seed;
  ps.viewPitch = 65000;
  ps.flags = PMF_GROUNDED | PMF_JUMP_HELD | PMF_CLIMBING;
  ps.groundEntity = ENTITY_WORLD;
  ps.waterLevel = 1;
  ps.stamina = 10000 - seed;
  ps.wallJumps = 2;
  ps.health = 7550 + seed;
  ps.armor = ARMOR_VEST;
  ps.submerged = 300;
  ps.climbHeight = -640;
  ps.climbYaw = 200;
  ps.regenDelay = 30;
  ps.kickCooldown = 12;
  ps.regrab = 9;
  ps.waterJump = 20;
  ps.bandage = 100;
  return ps;
}

/** The v4 fields' names, in declaration order (M4 design §2.2). */
const V4_FIELDS = [
  "wallJumps",
  "health",
  "armor",
  "submerged",
  "climbHeight",
  "climbYaw",
  "regenDelay",
  "kickCooldown",
  "regrab",
  "waterJump",
  "bandage",
] as const;
type V4Field = (typeof V4_FIELDS)[number];

/** Field values in declaration order, with −0 kept distinct from +0. */
function fields(ps: PlayerState): unknown[] {
  return [
    ...ps.origin,
    ...ps.velocity,
    ps.viewYaw,
    ps.viewPitch,
    ps.flags,
    ps.groundEntity,
    ps.waterLevel,
    ps.stamina,
    ...V4_FIELDS.map((k) => ps[k]),
  ].map((x) => (Object.is(x, -0) ? "-0" : x));
}

const V4_ZEROS = V4_FIELDS.map(() => 0);

afterEach(() => setDevAsserts(true));

describe("PlayerState", () => {
  it("starts at rest, airborne, dry and with integer scalars", () => {
    const ps = new PlayerState();
    expect(fields(ps)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, ENTITY_NONE, 0, 0, ...V4_ZEROS]);
    expect(ps.origin).toBeInstanceOf(Float64Array);
    expect(ps.velocity).toBeInstanceOf(Float64Array);
    expect(ENTITY_NONE).toBe(-1);
    expect(ENTITY_WORLD).toBe(32767);
  });

  it("declares its fields in the documented order (one shape for every instance)", () => {
    expect(Object.keys(new PlayerState())).toEqual([
      "origin",
      "velocity",
      "viewYaw",
      "viewPitch",
      "flags",
      "groundEntity",
      "waterLevel",
      "stamina",
      ...V4_FIELDS,
    ]);
  });

  it("has the 10 docs/03 §6 flags and GRAB_LOCK (M4 design §2.2) as bits 0..10", () => {
    const flags = [
      PMF_GROUNDED,
      PMF_CROUCHED,
      PMF_SLIDING,
      PMF_CLIMBING,
      PMF_ON_LADDER,
      PMF_JUMP_HELD,
      PMF_CROUCH_PRESSED_IN_AIR,
      PMF_LEGS_BROKEN,
      PMF_LEG_WOUND,
      PMF_IN_WATER,
      PMF_GRAB_LOCK,
    ];
    expect(PMF_MASK).toBe(0x7ff);
    expect(flags).toEqual(flags.map((_, i) => 1 << i));
    expect(flags.reduce((m, f) => m | f, 0)).toBe(PMF_MASK);
  });
});

describe("copyPlayerState / playerStateEquals / diffPlayerState", () => {
  it("copies every field without sharing vectors", () => {
    const src = sample();
    const dst = new PlayerState();
    const origin = dst.origin;
    expect(copyPlayerState(dst, src)).toBe(dst);
    expect(fields(dst)).toEqual(fields(src));
    expect(dst.origin).toBe(origin);
    src.origin[0] = 1;
    expect(dst.origin[0]).not.toBe(1);
  });

  it("equals compares every field, and diff names exactly the differing ones", () => {
    const a = sample();
    const b = copyPlayerState(new PlayerState(), a);
    expect(playerStateEquals(a, b)).toBe(true);
    expect(diffPlayerState(a, b)).toEqual([]);

    const mutations: [string, (ps: PlayerState) => void][] = [
      ["origin[0]", (ps) => (ps.origin[0] += 1 / 32)],
      ["origin[1]", (ps) => (ps.origin[1] += 1 / 32)],
      ["origin[2]", (ps) => (ps.origin[2] += 1 / 32)],
      ["velocity[0]", (ps) => (ps.velocity[0] += 1 / 16)],
      ["velocity[1]", (ps) => (ps.velocity[1] += 1 / 16)],
      ["velocity[2]", (ps) => (ps.velocity[2] += 1 / 16)],
      ["viewYaw", (ps) => (ps.viewYaw += 1)],
      ["viewPitch", (ps) => (ps.viewPitch += 1)],
      ["flags", (ps) => (ps.flags ^= PMF_IN_WATER)],
      ["groundEntity", (ps) => (ps.groundEntity = 3)],
      ["waterLevel", (ps) => (ps.waterLevel = 2)],
      ["stamina", (ps) => (ps.stamina += 1)],
      ...V4_FIELDS.map((k): [string, (ps: PlayerState) => void] => [k, (ps) => (ps[k] += 1)]),
    ];
    for (const [field, mutate] of mutations) {
      const c = copyPlayerState(new PlayerState(), a);
      mutate(c);
      expect(playerStateEquals(a, c), field).toBe(false);
      expect(playerStateEquals(c, a), field).toBe(false);
      const diff = diffPlayerState(a, c);
      expect(diff, field).toHaveLength(1);
      expect(diff[0]?.startsWith(`${field}: `), field).toBe(true);
    }
  });

  it("diff reports values as 'field: a → b'", () => {
    const a = new PlayerState();
    const b = new PlayerState();
    b.stamina = 250;
    b.origin[2] = -1.5;
    expect(diffPlayerState(a, b)).toEqual(["origin[2]: 0 → -1.5", "stamina: 0 → 250"]);
  });

  it("uses === semantics: NaN never equals, and the diff agrees", () => {
    const a = new PlayerState();
    const b = new PlayerState();
    a.velocity[1] = Number.NaN;
    b.velocity[1] = Number.NaN;
    expect(playerStateEquals(a, b)).toBe(false);
    expect(diffPlayerState(a, b)).toEqual(["velocity[1]: NaN → NaN"]);
  });
});

describe("quantizePlayerState", () => {
  it("snaps vectors to their grids and keeps integer fields", () => {
    const ps = new PlayerState();
    ps.origin.set([1 / 64, -1 / 64, 100.01]);
    ps.velocity.set([0.04, 320.03, -0.03]);
    ps.viewYaw = 123;
    ps.viewPitch = 65535;
    ps.flags = PMF_CROUCHED | PMF_SLIDING;
    ps.groundEntity = 12;
    ps.waterLevel = 2;
    ps.stamina = 9999;
    expect(quantizePlayerState(ps)).toBe(ps);
    expect(fields(ps)).toEqual([
      1 / 32,
      0,
      100,
      0.0625,
      320,
      0,
      123,
      65535,
      PMF_CROUCHED | PMF_SLIDING,
      12,
      2,
      9999,
      ...V4_ZEROS,
    ]);
  });

  it("is idempotent on random states, including out-of-range ones", () => {
    const rng = new Mulberry32(0x5eed);
    const r = (range: number) => (rng.nextFloat() * 2 - 1) * range;
    const bad: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const ps = new PlayerState();
      ps.origin.set([r(20000), r(20000), r(20000)]);
      ps.velocity.set([r(40000), r(40000), r(40000)]);
      ps.viewYaw = r(200000);
      ps.viewPitch = r(200000);
      ps.flags = r(4096);
      ps.groundEntity = r(40000);
      ps.waterLevel = r(5);
      ps.stamina = r(80000);
      for (const k of V4_FIELDS) ps[k] = r(70000);
      const once = copyPlayerState(new PlayerState(), quantizePlayerState(ps));
      quantizePlayerState(ps);
      // Failures collected and asserted once: 2000 states × 25 fields of expect() calls cost most
      // of a second of the fast tier's budget.
      if (diffPlayerState(once, ps).length > 0) bad.push(`state ${i}: not idempotent`);
      const f = fields(ps);
      for (let k = 0; k < f.length; k++) {
        const x = f[k];
        if (x === "-0" || !Number.isFinite(x)) bad.push(`state ${i}, field ${k}: ${String(x)}`);
        else if (k >= 6 && !Number.isInteger(x)) bad.push(`state ${i}, field ${k}: ${x}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("normalises −0 in every field to +0", () => {
    const ps = new PlayerState();
    ps.origin.set([-0, -1e-9, -1 / 64]);
    ps.velocity.set([-0, -1e-9, -1 / 32]);
    ps.viewYaw = -0;
    ps.viewPitch = -0.5;
    ps.flags = -0;
    ps.groundEntity = -0.5;
    ps.waterLevel = -0;
    ps.stamina = -0;
    ps.flags = PMF_CLIMBING;
    for (const k of V4_FIELDS) ps[k] = -0.5;
    quantizePlayerState(ps);
    expect(fields(ps)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, PMF_CLIMBING, 0, 0, 0, ...V4_ZEROS]);
  });

  it("clamps vectors to the codec range", () => {
    const ps = new PlayerState();
    ps.origin.set([ORIGIN_LIMIT, ORIGIN_LIMIT + 1, -ORIGIN_LIMIT - 1]);
    ps.velocity.set([VELOCITY_LIMIT, VELOCITY_LIMIT + 1, -1e9]);
    quantizePlayerState(ps);
    expect([...ps.origin]).toEqual([ORIGIN_LIMIT, ORIGIN_LIMIT, -ORIGIN_LIMIT]);
    expect([...ps.velocity]).toEqual([VELOCITY_LIMIT, VELOCITY_LIMIT, -VELOCITY_LIMIT]);
  });

  it.each([
    [0, 0],
    [65535, 65535],
    [65536, 0],
    [65537, 1],
    [-1, 65535],
    [-65536, 0],
    [1.9, 1],
    [-1.9, 65535],
    [2 ** 32 + 5, 5],
  ])("wraps view angle %f to %i", (x, q) => {
    const ps = new PlayerState();
    ps.viewYaw = x;
    ps.viewPitch = x;
    quantizePlayerState(ps);
    expect(ps.viewYaw).toBe(q);
    expect(ps.viewPitch).toBe(q);
  });

  it.each([
    [PMF_MASK, PMF_MASK],
    [PMF_MASK + 1, 0],
    [0xffff, PMF_MASK],
    [-1, PMF_MASK],
    [PMF_GROUNDED + 0.75, PMF_GROUNDED],
  ])("masks flags %f to %i", (x, q) => {
    const ps = new PlayerState();
    ps.flags = x;
    expect(quantizePlayerState(ps).flags).toBe(q);
  });

  it.each([
    [ENTITY_NONE, ENTITY_NONE],
    [-2, ENTITY_NONE],
    [-1e9, ENTITY_NONE],
    [-0.5, 0],
    [0, 0],
    [7.9, 7],
    [ENTITY_WORLD - 1, ENTITY_WORLD - 1],
    [ENTITY_WORLD, ENTITY_WORLD],
    [ENTITY_WORLD + 1, ENTITY_WORLD],
    [1e9, ENTITY_WORLD],
  ])("clamps groundEntity %f to %i", (x, q) => {
    const ps = new PlayerState();
    ps.groundEntity = x;
    expect(quantizePlayerState(ps).groundEntity).toBe(q);
  });

  it.each([
    [0, 0],
    [-1, 0],
    [0.9, 0],
    [1, 1],
    [2.5, 2],
    [WATER_LEVEL_MAX, WATER_LEVEL_MAX],
    [WATER_LEVEL_MAX + 0.5, WATER_LEVEL_MAX],
    [WATER_LEVEL_MAX + 1, WATER_LEVEL_MAX],
    [WATER_LEVEL_MAX + 1.5, WATER_LEVEL_MAX],
    [99, WATER_LEVEL_MAX],
  ])("clamps waterLevel %f to %i", (x, q) => {
    const ps = new PlayerState();
    ps.waterLevel = x;
    expect(quantizePlayerState(ps).waterLevel).toBe(q);
  });

  it.each([
    [0, 0],
    [-5, 0],
    [0.5, 1],
    [1234.49, 1234],
    [65535, 65535],
    [65535.4, 65535],
    [65536, 65535],
    [1e9, 65535],
  ])("rounds and clamps stamina %f to %i hundredths", (x, q) => {
    const ps = new PlayerState();
    ps.stamina = x;
    expect(quantizePlayerState(ps).stamina).toBe(q);
  });

  const nonFinite: [string, (ps: PlayerState, x: number) => void][] = [
    ["origin", (ps, x) => (ps.origin[1] = x)],
    ["velocity", (ps, x) => (ps.velocity[2] = x)],
    ["viewYaw", (ps, x) => (ps.viewYaw = x)],
    ["viewPitch", (ps, x) => (ps.viewPitch = x)],
    ["flags", (ps, x) => (ps.flags = x)],
    ["groundEntity", (ps, x) => (ps.groundEntity = x)],
    ["waterLevel", (ps, x) => (ps.waterLevel = x)],
    ["stamina", (ps, x) => (ps.stamina = x)],
    ...V4_FIELDS.map((k): [string, (ps: PlayerState, x: number) => void] => [
      k,
      (ps, x) => (ps[k] = x),
    ]),
  ];

  it.each(nonFinite)("asserts a finite %s in dev", (_field, set) => {
    for (const x of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const ps = sample();
      set(ps, x);
      expect(() => quantizePlayerState(ps)).toThrow(DevAssertError);
    }
  });

  it("maps NaN to 0 (groundEntity: ENTITY_NONE) with asserts off", () => {
    setDevAsserts(false);
    const ps = sample();
    for (const [, set] of nonFinite) set(ps, Number.NaN);
    quantizePlayerState(ps);
    expect(fields(ps)).toEqual([
      sample().origin[0],
      0,
      64,
      320,
      -0.0625,
      0,
      0,
      0,
      0,
      -1,
      0,
      0,
      ...V4_ZEROS,
    ]);
  });

  it("clamps ±Infinity to the bound and masks it to 0 with asserts off", () => {
    setDevAsserts(false);
    const ps = new PlayerState();
    ps.origin.set([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0]);
    ps.velocity.set([Number.NEGATIVE_INFINITY, 0, Number.POSITIVE_INFINITY]);
    ps.viewYaw = Number.POSITIVE_INFINITY;
    ps.viewPitch = Number.NEGATIVE_INFINITY;
    ps.flags = Number.POSITIVE_INFINITY;
    ps.groundEntity = Number.POSITIVE_INFINITY;
    ps.waterLevel = Number.POSITIVE_INFINITY;
    ps.stamina = Number.POSITIVE_INFINITY;
    for (const k of V4_FIELDS) ps[k] = Number.POSITIVE_INFINITY;
    quantizePlayerState(ps);
    expect(fields(ps)).toEqual([
      ORIGIN_LIMIT,
      -ORIGIN_LIMIT,
      0,
      -VELOCITY_LIMIT,
      0,
      VELOCITY_LIMIT,
      0,
      0,
      0,
      ENTITY_WORLD,
      WATER_LEVEL_MAX,
      65535,
      // Clamped counters take their width's maximum; masked fields 0; climb 0 (not CLIMBING).
      7,
      HEALTH_Q_MAX,
      0,
      2047,
      0,
      0,
      127,
      63,
      15,
      63,
      255,
    ]);
    ps.groundEntity = Number.NEGATIVE_INFINITY;
    expect(quantizePlayerState(ps).groundEntity).toBe(ENTITY_NONE);
  });

  it("maps a non-finite climb field while CLIMBING with asserts off: NaN 0, ±Infinity the bound", () => {
    setDevAsserts(false);
    const cases: [number, number, number][] = [
      // climbHeight in, climbHeight out, climbYaw out (the yaw takes the same input, masked).
      [Number.NaN, 0, 0],
      [Number.POSITIVE_INFINITY, 2047, 0],
      [Number.NEGATIVE_INFINITY, -2048, 0],
    ];
    for (const [x, height, yaw] of cases) {
      const ps = new PlayerState();
      ps.flags = PMF_CLIMBING;
      ps.climbHeight = x;
      ps.climbYaw = x;
      quantizePlayerState(ps);
      expect([ps.flags, ps.climbHeight, ps.climbYaw], String(x)).toEqual([
        PMF_CLIMBING,
        height,
        yaw,
      ]);
    }
  });
});

describe("quantizePlayerState: the v4 fields (M4 design §2.2)", () => {
  const climbing = (ps: PlayerState) => (ps.flags = PMF_CLIMBING);
  // field, input, quantized; every counter and timer truncates and clamps to 0..2^bits − 1.
  const cases: [V4Field, number, number][] = [
    ["wallJumps", 3.9, 3],
    ["wallJumps", 7, 7],
    ["wallJumps", 8, 7],
    ["wallJumps", -1, 0],
    ["health", 10000, 10000],
    ["health", 9999.99, 9999],
    ["health", HEALTH_Q_MAX + 1, HEALTH_Q_MAX],
    ["health", -250, 0],
    ["armor", ARMOR_VEST | ARMOR_HELMET, 3],
    ["armor", 4, 0],
    ["armor", 5.5, 1],
    ["armor", -1, 3],
    ["submerged", 2047, 2047],
    ["submerged", 2048, 2047],
    ["submerged", 959.5, 959],
    ["regenDelay", 127, 127],
    ["regenDelay", 128, 127],
    ["kickCooldown", 63, 63],
    ["kickCooldown", 64, 63],
    ["regrab", 15, 15],
    ["regrab", 16, 15],
    ["waterJump", 63, 63],
    ["waterJump", 64, 63],
    ["bandage", 255, 255],
    ["bandage", 256, 255],
    ["bandage", 0.5, 0],
  ];
  it.each(cases)("quantizes %s %f to %i", (field, x, q) => {
    const ps = new PlayerState();
    ps[field] = x;
    expect(quantizePlayerState(ps)[field]).toBe(q);
  });

  it.each([
    [2047, 2047],
    [2048, 2047],
    [-2048, -2048],
    [-2049, -2048],
    [-12.75, -12],
    [12.75, 12],
  ])("truncates and clamps climbHeight %f to %i (i12) while CLIMBING", (x, q) => {
    const ps = new PlayerState();
    climbing(ps);
    ps.climbHeight = x;
    expect(quantizePlayerState(ps).climbHeight).toBe(q);
  });

  it.each([
    [255, 255],
    [256, 0],
    [-1, 255],
    [17.9, 17],
  ])("masks climbYaw %f to %i while CLIMBING", (x, q) => {
    const ps = new PlayerState();
    climbing(ps);
    ps.climbYaw = x;
    expect(quantizePlayerState(ps).climbYaw).toBe(q);
  });

  it("zeroes climbHeight and climbYaw whenever CLIMBING is clear (the canonical rule)", () => {
    const ps = sample();
    expect(quantizePlayerState(ps).climbHeight).toBe(-640);
    expect(ps.climbYaw).toBe(200);
    ps.flags &= ~PMF_CLIMBING;
    quantizePlayerState(ps);
    expect([ps.climbHeight, ps.climbYaw]).toEqual([0, 0]);
    // regrab doubles as the climb finish counter, and keeps its value either way.
    expect(ps.regrab).toBe(9);
  });
});

describe("resetPlayerStateForSpawn (M4 design §2.2)", () => {
  it("resets every field but the origin and the view, with full health and the given armor", () => {
    for (const armor of [0, ARMOR_VEST, ARMOR_VEST | ARMOR_HELMET, 0xff]) {
      const ps = sample();
      expect(resetPlayerStateForSpawn(ps, armor)).toBe(ps);
      const expected = new PlayerState();
      expected.origin.set(sample().origin);
      expected.viewYaw = sample().viewYaw;
      expected.viewPitch = sample().viewPitch;
      expected.stamina = PLAYER_STAMINA_FULL;
      expected.health = PLAYER_HEALTH_MAX;
      expected.armor = armor & 3;
      expect(diffPlayerState(expected, ps), `armor ${armor}`).toEqual([]);
    }
    expect(PLAYER_HEALTH_MAX).toBe(10000);
  });

  it("leaves a state quantize keeps (a spawn is a state the wire carries)", () => {
    const ps = resetPlayerStateForSpawn(sample(), ARMOR_VEST);
    const once = copyPlayerState(new PlayerState(), ps);
    expect(diffPlayerState(once, quantizePlayerState(ps))).toEqual([]);
  });
});

describe("PlayerStateRing", () => {
  it("has a power-of-two capacity of 128", () => {
    expect(PLAYER_STATE_RING_CAPACITY).toBe(128);
  });

  it("misses every tick before anything is written", () => {
    const ring = new PlayerStateRing();
    const out = sample();
    for (const tick of [0, 1, 127, 128, 1000, TICK_MAX]) {
      expect(ring.has(tick)).toBe(false);
      expect(ring.read(tick, out)).toBe(false);
    }
    expect(fields(out)).toEqual(fields(sample()));
  });

  it("stores copies, not references", () => {
    const ring = new PlayerStateRing();
    const src = sample(3);
    ring.write(10, src);
    src.origin[0] = -999;
    src.stamina = 1;
    const out = new PlayerState();
    expect(ring.read(10, out)).toBe(true);
    expect(fields(out)).toEqual(fields(sample(3)));
  });

  it("keeps the last 128 ticks across wraparound and detects stale slots", () => {
    const ring = new PlayerStateRing();
    const st = new PlayerState();
    for (let tick = 0; tick < 1000; tick++) {
      st.stamina = tick;
      ring.write(tick, st);
    }
    const out = new PlayerState();
    for (let tick = 1000 - 128; tick < 1000; tick++) {
      expect(ring.read(tick, out)).toBe(true);
      expect(out.stamina).toBe(tick);
    }
    out.stamina = -5;
    // Same slots as held ticks, but overwritten (older) or never written (newer).
    for (const tick of [0, 1000 - 129, 1000 - 256, 1000, 1000 + 127, 1000 + 128]) {
      expect(ring.has(tick)).toBe(false);
      expect(ring.read(tick, out)).toBe(false);
    }
    expect(out.stamina).toBe(-5);
  });

  it("works at the top of the tick range", () => {
    const ring = new PlayerStateRing();
    ring.write(TICK_MAX, sample(2));
    const out = new PlayerState();
    expect(ring.read(TICK_MAX, out)).toBe(true);
    expect(fields(out)).toEqual(fields(sample(2)));
    expect(ring.read(TICK_MAX - 128, out)).toBe(false);
  });

  it("rejects ticks outside 0..TICK_MAX: asserts on write, ignores them with asserts off", () => {
    const ring = new PlayerStateRing();
    const out = new PlayerState();
    const bad = [-1, -128, 1.5, Number.NaN, TICK_MAX + 1, Number.POSITIVE_INFINITY];
    for (const tick of bad) {
      expect(() => ring.write(tick, sample())).toThrow(DevAssertError);
      expect(ring.read(tick, out)).toBe(false);
      expect(ring.has(tick)).toBe(false);
    }
    setDevAsserts(false);
    for (const tick of bad) ring.write(tick, sample());
    // -1 would alias the empty-slot marker in slot 127; it must still miss.
    for (const tick of bad) expect(ring.read(tick, out)).toBe(false);
    for (let tick = 0; tick < 256; tick++) expect(ring.has(tick)).toBe(false);
  });

  it("clear forgets every tick", () => {
    const ring = new PlayerStateRing();
    for (let tick = 0; tick < 200; tick++) ring.write(tick, sample());
    ring.clear();
    for (let tick = 0; tick < 200; tick++) expect(ring.has(tick)).toBe(false);
  });
});
