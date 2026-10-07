import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("hot-path reads", () => {
  it("never lowercase the registered spelling (no per-call string allocation)", () => {
    const lower = vi.spyOn(String.prototype, "toLowerCase");
    let calls: number;
    try {
      cvars.get("pm_maxWallJumps");
      cvars.has("pm_gravity");
      cvars.info("pm_gravity");
      cvars.set("pm_maxWallJumps", 4);
      calls = lower.mock.calls.length;
    } finally {
      lower.mockRestore();
    }
    expect(calls).toBe(0);
    expect(cvars.get("PM_GRAVITY")).toBe(800);
  });
});

describe("flags", () => {
  it("uses one distinct bit per flag", () => {
    const bits = Object.values(CvarFlag).filter((bit) => bit !== 0);
    for (const bit of bits) expect(bit & (bit - 1), `${bit} is one bit`).toBe(0);
    expect(new Set(bits).size).toBe(bits.length);
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

  it("accepts the full int32 range and nothing beyond it", () => {
    cvars.register({ name: "g_score", type: "int", default: 0, description: "x" });
    expect(cvars.set("g_score", -(2 ** 31)).ok).toBe(true);
    expect(cvars.set("g_score", -(2 ** 31) - 1)).toEqual({ ok: false, error: "type" });
    expect(cvars.set("g_score", 2 ** 31 - 1).ok).toBe(true);
  });

  it("stores a -0 default as 0", () => {
    cvars.register({ name: "pm_bias", type: "float", default: -0, description: "x" });
    expect(Object.is(cvars.get("pm_bias"), 0)).toBe(true);
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

  it("returns applied LATCH names sorted, not in registration order", () => {
    // Registered after pm_gravity and sv_fps, but sorts first (and in a different case).
    cvars.register({
      name: "ai_Level",
      type: "int",
      default: 0,
      description: "x",
      flags: CvarFlag.LATCH,
    });
    cvars.setAllowCheats(true);
    cvars.set("sv_fps", 30);
    cvars.set("pm_gravity", 600);
    cvars.set("ai_Level", 2);
    expect(cvars.applyLatched()).toEqual(["ai_Level", "pm_gravity", "sv_fps"]);
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

describe("version", () => {
  it("counts registrations", () => {
    const fresh = new CvarRegistry();
    expect(fresh.version).toBe(0);
    fresh.register({ name: "pm_a", type: "float", default: 1, description: "x" });
    fresh.register({ name: "pm_b", type: "float", default: 1, description: "x" });
    expect(fresh.version).toBe(2);
  });

  it("bumps on every value change: set, setFromString and reset", () => {
    let v = cvars.version;
    cvars.set("sensitivity", 2);
    expect(cvars.version).toBe(++v);
    cvars.set("sensitivity", 500); // clamped to 100, still a change
    expect(cvars.version).toBe(++v);
    cvars.setFromString("pm_maxWallJumps", "1");
    expect(cvars.version).toBe(++v);
    cvars.reset("pm_maxWallJumps");
    expect(cvars.version).toBe(++v);
    cvars.set("cl_drawfps", true);
    cvars.set("sv_hostname", "eu-1");
    expect(cvars.version).toBe(v + 2);
  });

  it("stays put when nothing changes", () => {
    const v = cvars.version;
    cvars.set("sensitivity", 5);
    cvars.reset("sensitivity");
    cvars.set("sensitivity", 1000);
    cvars.set("sensitivity", 100); // already clamped to 100 by the line above
    expect(cvars.version).toBe(v + 1);
    const w = cvars.version;
    cvars.set("sensitivity", "fast");
    cvars.setFromString("sensitivity", "fast");
    cvars.set("nope", 1);
    cvars.set("cg_thirdperson", true); // cheat-protected
    cvars.set("sensitivity", 0); // clamped to the 0.1 min: the one change
    cvars.set("sensitivity", 0.1); // already 0.1
    expect(cvars.version).toBe(w + 1);
    const x = cvars.version;
    cvars.set("pm_maxWallJumps", 0); // 3 → 0: a change
    cvars.set("pm_maxWallJumps", -0); // stored as 0: not a change
    expect(cvars.version).toBe(x + 1);
  });

  it("reads numbers with a fallback for missing and non-numeric cvars", () => {
    expect(cvars.getNumber("pm_gravity", 1)).toBe(800);
    expect(cvars.getNumber("PM_GRAVITY", 1)).toBe(800);
    expect(cvars.getNumber("nope", 7)).toBe(7);
    expect(cvars.getNumber("sv_hostname", 7)).toBe(7);
    expect(cvars.getNumber("cl_drawfps", 7)).toBe(7);
  });

  it("waits for applyLatched() on LATCH cvars, which bumps once per changed value", () => {
    const v = cvars.version;
    cvars.set("pm_gravity", 600);
    cvars.reset("pm_gravity");
    cvars.set("pm_gravity", 600);
    expect(cvars.version).toBe(v);
    cvars.applyLatched();
    expect(cvars.version).toBe(v + 1);
    cvars.applyLatched();
    expect(cvars.version).toBe(v + 1);
  });

  it("bumps when turning cheats off resets a changed CHEAT cvar", () => {
    cvars.setAllowCheats(true);
    cvars.setAllowCheats(false);
    const v = cvars.version;
    cvars.setAllowCheats(true);
    cvars.set("cg_thirdperson", true);
    expect(cvars.version).toBe(v + 1);
    cvars.set("sv_fps", 30); // LATCH: pending only
    cvars.setAllowCheats(false);
    expect(cvars.version).toBe(v + 2);
    expect(cvars.get("sv_fps")).toBe(60);
  });
});

describe("replicated cvars fit the cvar block (D-027)", () => {
  const R = CvarFlag.REPLICATED;

  it("refuses names past 63 chars and unencodable string defaults at registration", () => {
    const reg = new CvarRegistry();
    reg.register({
      name: `pm_${"a".repeat(60)}`,
      type: "int",
      default: 0,
      description: "",
      flags: R,
    });
    expect(() =>
      reg.register({
        name: `pm_${"b".repeat(61)}`,
        type: "int",
        default: 0,
        description: "",
        flags: R,
      }),
    ).toThrow(/longer than 63/);
    // Not replicated: no wire limit.
    reg.register({ name: `cl_${"c".repeat(70)}`, type: "int", default: 0, description: "" });
    for (const bad of ["café", "tab\there", "x".repeat(256)]) {
      expect(() =>
        reg.register({ name: "g_motd", type: "string", default: bad, description: "", flags: R }),
      ).toThrow(/not a valid string/);
    }
    reg.register({
      name: "g_motd",
      type: "string",
      default: "x".repeat(255),
      description: "",
      flags: R,
    });
  });

  it("refuses unencodable values for replicated strings on every set path", () => {
    const reg = new CvarRegistry();
    reg.register({ name: "g_motd", type: "string", default: "hi", description: "", flags: R });
    reg.register({ name: "cl_name", type: "string", default: "hi", description: "" });
    const v = reg.version;
    expect(reg.set("g_motd", "Grüße")).toEqual({ ok: false, error: "type" });
    expect(reg.setFromString("g_motd", "café")).toEqual({ ok: false, error: "type" });
    expect(reg.set("g_motd", "x".repeat(256))).toEqual({ ok: false, error: "type" });
    expect(reg.setReplicated("g_motd", "café")).toBe(false);
    expect([reg.get("g_motd"), reg.version]).toEqual(["hi", v]);
    expect(reg.set("g_motd", "welcome!").ok).toBe(true);
    // A local string takes any text.
    expect(reg.set("cl_name", "Grüße").ok).toBe(true);
  });

  it("setReplicated stores a server value as sent, past CHEAT and LATCH, but never clamps", () => {
    const reg = new CvarRegistry();
    reg.register({
      name: "pm_gravity",
      type: "float",
      default: 800,
      min: 0,
      max: 4000,
      description: "",
      flags: R | CvarFlag.CHEAT | CvarFlag.LATCH,
    });
    reg.register({ name: "cl_fov", type: "float", default: 90, description: "" });
    expect(reg.set("pm_gravity", 100)).toEqual({ ok: false, error: "cheat" });
    const v = reg.version;
    expect(reg.setReplicated("pm_gravity", 400.5)).toBe(true);
    expect([reg.get("pm_gravity"), reg.version]).toEqual([400.5, v + 1]);
    expect(reg.setReplicated("pm_gravity", 400.5)).toBe(true);
    expect(reg.version).toBe(v + 1);
    for (const bad of [-1, 4001, Number.NaN, "800", true]) {
      expect(reg.setReplicated("pm_gravity", bad)).toBe(false);
    }
    expect(reg.setReplicated("cl_fov", 100)).toBe(false);
    expect(reg.setReplicated("nope", 1)).toBe(false);
    expect([reg.get("pm_gravity"), reg.get("cl_fov"), reg.version]).toEqual([400.5, 90, v + 1]);
  });
});
