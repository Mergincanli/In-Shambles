import { beforeEach, describe, expect, it } from "vitest";
import { CvarFlag, CvarRegistry } from "../src/cvars";

let cvars: CvarRegistry;

beforeEach(() => {
  cvars = new CvarRegistry();
  // Spec names (docs/03 §2, §5) with test values.
  cvars.register({
    name: "sensitivity",
    type: "float",
    default: 5,
    min: 0.1,
    max: 100,
    description: "mouse",
    flags: CvarFlag.ARCHIVE,
  });
  cvars.register({
    name: "pm_maxWallJumps",
    type: "int",
    default: 3,
    min: 0,
    max: 10,
    description: "test",
    flags: CvarFlag.REPLICATED,
  });
  cvars.register({
    name: "pm_gravity",
    type: "float",
    default: 800,
    description: "test",
    flags: CvarFlag.REPLICATED | CvarFlag.LATCH,
  });
  cvars.register({ name: "cl_drawfps", type: "bool", default: false, description: "test" });
  cvars.register({
    name: "sv_hostname",
    type: "string",
    default: "local",
    description: "test",
    flags: CvarFlag.SERVER,
  });
  cvars.register({
    name: "cg_thirdperson",
    type: "bool",
    default: false,
    description: "test",
    flags: CvarFlag.CHEAT,
  });
  cvars.register({
    name: "sv_fps",
    type: "int",
    default: 60,
    min: 20,
    max: 128,
    description: "test",
    flags: CvarFlag.SERVER | CvarFlag.LATCH | CvarFlag.CHEAT,
  });
});

describe("register", () => {
  it("exposes defaults and definitions", () => {
    expect(cvars.get("sensitivity")).toBe(5);
    expect(cvars.get("cl_drawfps")).toBe(false);
    expect(cvars.info("sv_hostname")?.def.flags).toBe(CvarFlag.SERVER);
    expect(cvars.get("missing")).toBeUndefined();
  });

  it("accepts the camelCase names the specs use", () => {
    for (const name of ["pm_airAccelerate", "st_sprintDrain", "sv_maxRewindMs", "g_walljumps"]) {
      cvars.register({ name, type: "float", default: 1, description: "spec name" });
    }
    expect(cvars.has("pm_airAccelerate")).toBe(true);
  });

  it("looks names up case-insensitively, Quake-style, and keeps the registered spelling", () => {
    expect(cvars.get("PM_MAXWALLJUMPS")).toBe(3);
    expect(cvars.setFromString("pm_maxwalljumps", "2").ok).toBe(true);
    expect(cvars.get("pm_maxWallJumps")).toBe(2);
    expect(cvars.info("pm_maxwalljumps")?.def.name).toBe("pm_maxWallJumps");
  });

  it("rejects duplicate names, including ones that differ only by case", () => {
    const def = { name: "sensitivity", type: "float", default: 1, description: "x" } as const;
    expect(() => cvars.register(def)).toThrow(/already registered/);
    expect(() => cvars.register({ ...def, name: "Sensitivity" })).toThrow(/invalid cvar name/);
    expect(() => cvars.register({ ...def, name: "pm_MaxWallJumps" })).toThrow(/already registered/);
  });

  it("rejects invalid names", () => {
    for (const name of ["Bad-Name", "1st", "_x", "has space", ""]) {
      expect(() => cvars.register({ name, type: "int", default: 0, description: "x" })).toThrow(
        /invalid cvar name/,
      );
    }
  });

  it("rejects defaults that don't match the type or range", () => {
    expect(() =>
      cvars.register({ name: "a", type: "int", default: 1.5, description: "x" }),
    ).toThrow(/default/);
    expect(() =>
      cvars.register({ name: "b", type: "float", default: 50, min: 0, max: 10, description: "x" }),
    ).toThrow(/default/);
    expect(() =>
      cvars.register({ name: "c", type: "int", default: 2 ** 31, description: "x" }),
    ).toThrow(/default/);
    expect(() =>
      cvars.register({ name: "d", type: "float", default: Number.NaN, description: "x" }),
    ).toThrow(/default/);
  });

  it("rejects invalid bounds", () => {
    expect(() =>
      cvars.register({ name: "a", type: "float", default: 1, min: 5, max: 2, description: "x" }),
    ).toThrow(/min/);
    expect(() =>
      cvars.register({ name: "b", type: "float", default: 1, min: Number.NaN, description: "x" }),
    ).toThrow(/min/);
    expect(() =>
      cvars.register({
        name: "c",
        type: "float",
        default: 1,
        max: Number.POSITIVE_INFINITY,
        description: "x",
      }),
    ).toThrow(/max/);
    expect(() =>
      cvars.register({ name: "d", type: "int", default: 1, min: 0.5, max: 2, description: "x" }),
    ).toThrow(/min/);
    expect(() =>
      cvars.register({ name: "e", type: "bool", default: true, min: 0, description: "x" } as never),
    ).toThrow(/min\/max/);
  });
});

describe("set", () => {
  it("sets values of the right type", () => {
    expect(cvars.set("sensitivity", 2.5)).toEqual({
      ok: true,
      value: 2.5,
      clamped: false,
      latched: false,
    });
    expect(cvars.get("sensitivity")).toBe(2.5);
    expect(cvars.set("cl_drawfps", true).ok).toBe(true);
    expect(cvars.set("sv_hostname", "eu-1").ok).toBe(true);
  });

  it("clamps numbers to min/max", () => {
    expect(cvars.set("sensitivity", 500)).toEqual({
      ok: true,
      value: 100,
      clamped: true,
      latched: false,
    });
    expect(cvars.set("pm_maxWallJumps", -2)).toMatchObject({ ok: true, value: 0, clamped: true });
  });

  it("rejects wrong types and out-of-range ints without changing the value", () => {
    expect(cvars.set("pm_maxWallJumps", 2.5)).toEqual({ ok: false, error: "type" });
    expect(cvars.set("pm_maxWallJumps", 2 ** 31)).toEqual({ ok: false, error: "type" });
    expect(cvars.set("sensitivity", Number.NaN)).toEqual({ ok: false, error: "type" });
    expect(cvars.set("sensitivity", Number.POSITIVE_INFINITY)).toEqual({
      ok: false,
      error: "type",
    });
    expect(cvars.set("cl_drawfps", "yes")).toEqual({ ok: false, error: "type" });
    expect(cvars.get("pm_maxWallJumps")).toBe(3);
  });

  it("stores -0 as 0", () => {
    cvars.register({ name: "pm_offset", type: "float", default: 1, description: "x" });
    cvars.set("pm_offset", -0);
    expect(Object.is(cvars.get("pm_offset"), 0)).toBe(true);
  });

  it("rejects unknown cvars", () => {
    expect(cvars.set("nope", 1)).toEqual({ ok: false, error: "unknown" });
    expect(cvars.setFromString("nope", "1")).toEqual({ ok: false, error: "unknown" });
    expect(cvars.reset("nope")).toEqual({ ok: false, error: "unknown" });
  });

  it("holds LATCH values until applyLatched()", () => {
    expect(cvars.set("pm_gravity", 600)).toMatchObject({ ok: true, latched: true });
    expect(cvars.get("pm_gravity")).toBe(800);
    expect(cvars.info("pm_gravity")?.latched).toBe(600);
    expect(cvars.applyLatched()).toEqual(["pm_gravity"]);
    expect(cvars.get("pm_gravity")).toBe(600);
    expect(cvars.info("pm_gravity")?.latched).toBeUndefined();
  });

  it("makes reset() of a LATCH cvar wait for applyLatched() too", () => {
    cvars.set("pm_gravity", 600);
    cvars.applyLatched();
    expect(cvars.reset("pm_gravity")).toMatchObject({ ok: true, latched: true });
    expect(cvars.get("pm_gravity")).toBe(600);
    expect(cvars.applyLatched()).toEqual(["pm_gravity"]);
    expect(cvars.get("pm_gravity")).toBe(800);
  });

  it("cancels a pending LATCH value when set back to the current value", () => {
    cvars.set("pm_gravity", 600);
    expect(cvars.set("pm_gravity", 800)).toMatchObject({ ok: true, latched: false });
    expect(cvars.info("pm_gravity")?.latched).toBeUndefined();
    expect(cvars.applyLatched()).toEqual([]);
    expect(cvars.reset("pm_gravity")).toMatchObject({ ok: true, latched: false });
  });
});

describe("cheats", () => {
  it("blocks CHEAT cvars unless cheats are allowed, on every path", () => {
    expect(cvars.cheatsAllowed()).toBe(false);
    expect(cvars.set("cg_thirdperson", true)).toEqual({ ok: false, error: "cheat" });
    expect(cvars.setFromString("cg_thirdperson", "1")).toEqual({ ok: false, error: "cheat" });
    cvars.setAllowCheats(true);
    expect(cvars.set("cg_thirdperson", true).ok).toBe(true);
  });

  it("resets CHEAT cvars and drops their pending values when cheats are turned off", () => {
    cvars.setAllowCheats(true);
    cvars.set("cg_thirdperson", true);
    cvars.set("sv_fps", 30);
    expect(cvars.info("sv_fps")?.latched).toBe(30);
    cvars.setAllowCheats(false);
    expect(cvars.get("cg_thirdperson")).toBe(false);
    expect(cvars.info("sv_fps")?.latched).toBeUndefined();
    expect(cvars.applyLatched()).toEqual([]);
    expect(cvars.get("sv_fps")).toBe(60);
  });

  it("lets CHEAT cvars reset to the default whether or not cheats are on", () => {
    cvars.setAllowCheats(true);
    cvars.set("cg_thirdperson", true);
    expect(cvars.reset("cg_thirdperson").ok).toBe(true);
    expect(cvars.get("cg_thirdperson")).toBe(false);
    cvars.setAllowCheats(false);
    expect(cvars.reset("cg_thirdperson").ok).toBe(true);
  });
});

describe("setFromString", () => {
  it("parses each type", () => {
    expect(cvars.setFromString("pm_maxWallJumps", " 2 ").ok).toBe(true);
    expect(cvars.get("pm_maxWallJumps")).toBe(2);
    expect(cvars.setFromString("pm_maxWallJumps", "+4").ok).toBe(true);
    expect(cvars.get("pm_maxWallJumps")).toBe(4);
    expect(cvars.setFromString("sensitivity", "3.25").ok).toBe(true);
    expect(cvars.get("sensitivity")).toBe(3.25);
    expect(cvars.setFromString("sensitivity", ".5").ok).toBe(true);
    expect(cvars.get("sensitivity")).toBe(0.5);
    expect(cvars.setFromString("sensitivity", "1e1").ok).toBe(true);
    expect(cvars.get("sensitivity")).toBe(10);
    expect(cvars.setFromString("cl_drawfps", "1").ok).toBe(true);
    expect(cvars.get("cl_drawfps")).toBe(true);
    expect(cvars.setFromString("cl_drawfps", "FALSE").ok).toBe(true);
    expect(cvars.get("cl_drawfps")).toBe(false);
    expect(cvars.setFromString("sv_hostname", "my server").ok).toBe(true);
    expect(cvars.get("sv_hostname")).toBe("my server");
  });

  it("rejects text that doesn't parse as a decimal of the right type", () => {
    for (const text of ["2.5", "0x10", "2147483648", "9007199254740993", ""]) {
      expect(cvars.setFromString("pm_maxWallJumps", text), text).toEqual({
        ok: false,
        error: "type",
      });
    }
    for (const text of ["", "fast", "0x10", "0b1", "Infinity", "NaN", "1e999"]) {
      expect(cvars.setFromString("sensitivity", text), text).toEqual({ ok: false, error: "type" });
    }
    expect(cvars.setFromString("cl_drawfps", "yes")).toEqual({ ok: false, error: "type" });
    expect(cvars.setFromString("sensitivity", "3.25abc")).toEqual({ ok: false, error: "type" });
    expect(cvars.setFromString("pm_maxWallJumps", "2 3")).toEqual({ ok: false, error: "type" });
  });

  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["0", false],
    ["false", false],
    ["False", false],
  ])("parses bool %j as %s", (text, expected) => {
    cvars.set("cl_drawfps", !expected);
    expect(cvars.setFromString("cl_drawfps", text).ok).toBe(true);
    expect(cvars.get("cl_drawfps")).toBe(expected);
  });

  it('stores "-0" as 0', () => {
    cvars.register({ name: "pm_offset", type: "float", default: 1, description: "x" });
    cvars.setFromString("pm_offset", "-0");
    expect(Object.is(cvars.get("pm_offset"), 0)).toBe(true);
  });
});

describe("list and replicated", () => {
  it("lists cvars sorted by name, optionally by case-insensitive prefix", () => {
    expect(cvars.list().map((c) => c.def.name)).toEqual([
      "cg_thirdperson",
      "cl_drawfps",
      "pm_gravity",
      "pm_maxWallJumps",
      "sensitivity",
      "sv_fps",
      "sv_hostname",
    ]);
    expect(cvars.list("PM_").map((c) => c.def.name)).toEqual(["pm_gravity", "pm_maxWallJumps"]);
  });

  it("returns the REPLICATED cvars sorted by name", () => {
    expect(cvars.replicated().map((c) => c.def.name)).toEqual(["pm_gravity", "pm_maxWallJumps"]);
  });
});
