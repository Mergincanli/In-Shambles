import { afterEach, describe, expect, it } from "vitest";
import { DevAssertError, setDevAsserts } from "../../src/debug/assert";
import { ORIGIN_LIMIT, VELOCITY_LIMIT } from "../../src/math/quant";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { ENTITY_NONE, ENTITY_WORLD } from "../../src/sim/entity";
import {
  copyPlayerState,
  diffPlayerState,
  PLAYER_STATE_RING_CAPACITY,
  PlayerState,
  PlayerStateRing,
  PMF_CLIMBING,
  PMF_CROUCH_PRESSED_IN_AIR,
  PMF_CROUCHED,
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
  ps.flags = PMF_GROUNDED | PMF_JUMP_HELD;
  ps.groundEntity = ENTITY_WORLD;
  ps.waterLevel = 1;
  ps.stamina = 10000 - seed;
  return ps;
}

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
  ].map((x) => (Object.is(x, -0) ? "-0" : x));
}

afterEach(() => setDevAsserts(true));

describe("PlayerState", () => {
  it("starts at rest, airborne, dry and with integer scalars", () => {
    const ps = new PlayerState();
    expect(fields(ps)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, ENTITY_NONE, 0, 0]);
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
    ]);
  });

  it("has the 10 docs/03 §6 flags as bits 0..9", () => {
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
    ];
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
    ]);
  });

  it("is idempotent on random states, including out-of-range ones", () => {
    const rng = new Mulberry32(0x5eed);
    const r = (range: number) => (rng.nextFloat() * 2 - 1) * range;
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
      const once = copyPlayerState(new PlayerState(), quantizePlayerState(ps));
      quantizePlayerState(ps);
      expect(diffPlayerState(once, ps)).toEqual([]);
      for (const x of fields(ps)) {
        expect(x).not.toBe("-0");
        expect(Number.isFinite(x)).toBe(true);
      }
      for (let k = 6; k < 12; k++) expect(Number.isInteger(fields(ps)[k])).toBe(true);
    }
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
    quantizePlayerState(ps);
    expect(fields(ps)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
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
    expect(fields(ps)).toEqual([sample().origin[0], 0, 64, 320, -0.0625, 0, 0, 0, 0, -1, 0, 0]);
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
    ]);
    ps.groundEntity = Number.NEGATIVE_INFINITY;
    expect(quantizePlayerState(ps).groundEntity).toBe(ENTITY_NONE);
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
