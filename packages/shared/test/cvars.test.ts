import { beforeEach, describe, expect, it } from "vitest";
import { CvarFlag, CvarRegistry } from "../src/cvars";

let cvars: CvarRegistry;

beforeEach(() => {
  cvars = new CvarRegistry();
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
    name: "pm_max_wall_jumps",
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
});

describe("register", () => {
  it("exposes defaults and definitions", () => {
    expect(cvars.get("sensitivity")).toBe(5);
    expect(cvars.get("cl_drawfps")).toBe(false);
    expect(cvars.info("sv_hostname")?.def.flags).toBe(CvarFlag.SERVER);
    expect(cvars.get("missing")).toBeUndefined();
  });

  it("rejects duplicate and invalid names", () => {
    const def = { name: "sensitivity", type: "float", default: 1, description: "x" } as const;
    expect(() => cvars.register(def)).toThrow(/already registered/);
    expect(() => cvars.register({ ...def, name: "Bad-Name" })).toThrow(/invalid cvar name/);
  });

  it("rejects defaults that don't match the type or range", () => {
    expect(() =>
      cvars.register({ name: "a", type: "int", default: 1.5, description: "x" }),
    ).toThrow(/default/);
    expect(() =>
      cvars.register({ name: "b", type: "float", default: 50, min: 0, max: 10, description: "x" }),
    ).toThrow(/default/);
    expect(() =>
      cvars.register({ name: "c", type: "float", default: 1, min: 5, max: 2, description: "x" }),
    ).toThrow(/min/);
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
    expect(cvars.set("pm_max_wall_jumps", -2)).toMatchObject({ ok: true, value: 0, clamped: true });
  });

  it("rejects wrong types without changing the value", () => {
    expect(cvars.set("pm_max_wall_jumps", 2.5)).toEqual({ ok: false, error: "type" });
    expect(cvars.set("sensitivity", Number.NaN)).toEqual({ ok: false, error: "type" });
    expect(cvars.set("cl_drawfps", "yes")).toEqual({ ok: false, error: "type" });
    expect(cvars.get("pm_max_wall_jumps")).toBe(3);
  });

  it("rejects unknown cvars", () => {
    expect(cvars.set("nope", 1)).toEqual({ ok: false, error: "unknown" });
  });

  it("blocks CHEAT cvars unless cheats are allowed", () => {
    expect(cvars.set("cg_thirdperson", true)).toEqual({ ok: false, error: "cheat" });
    cvars.allowCheats = true;
    expect(cvars.set("cg_thirdperson", true).ok).toBe(true);
  });

  it("holds LATCH values until applyLatched()", () => {
    expect(cvars.set("pm_gravity", 600)).toMatchObject({ ok: true, latched: true });
    expect(cvars.get("pm_gravity")).toBe(800);
    expect(cvars.info("pm_gravity")?.latched).toBe(600);
    expect(cvars.applyLatched()).toEqual(["pm_gravity"]);
    expect(cvars.get("pm_gravity")).toBe(600);
    expect(cvars.info("pm_gravity")?.latched).toBeUndefined();
  });
});

describe("setFromString", () => {
  it("parses each type", () => {
    expect(cvars.setFromString("pm_max_wall_jumps", "2").ok).toBe(true);
    expect(cvars.get("pm_max_wall_jumps")).toBe(2);
    expect(cvars.setFromString("sensitivity", "3.25").ok).toBe(true);
    expect(cvars.get("sensitivity")).toBe(3.25);
    expect(cvars.setFromString("cl_drawfps", "1").ok).toBe(true);
    expect(cvars.get("cl_drawfps")).toBe(true);
    expect(cvars.setFromString("cl_drawfps", "FALSE").ok).toBe(true);
    expect(cvars.get("cl_drawfps")).toBe(false);
    expect(cvars.setFromString("sv_hostname", "my server").ok).toBe(true);
    expect(cvars.get("sv_hostname")).toBe("my server");
  });

  it("rejects text that doesn't parse", () => {
    expect(cvars.setFromString("pm_max_wall_jumps", "2.5")).toEqual({ ok: false, error: "type" });
    expect(cvars.setFromString("sensitivity", "")).toEqual({ ok: false, error: "type" });
    expect(cvars.setFromString("sensitivity", "fast")).toEqual({ ok: false, error: "type" });
    expect(cvars.setFromString("cl_drawfps", "yes")).toEqual({ ok: false, error: "type" });
  });
});

describe("reset, list and replicated", () => {
  it("resets to the default, even for CHEAT cvars", () => {
    cvars.allowCheats = true;
    cvars.set("cg_thirdperson", true);
    cvars.allowCheats = false;
    expect(cvars.reset("cg_thirdperson").ok).toBe(true);
    expect(cvars.get("cg_thirdperson")).toBe(false);
  });

  it("lists cvars sorted by name, optionally by prefix", () => {
    expect(cvars.list().map((c) => c.def.name)).toEqual([
      "cg_thirdperson",
      "cl_drawfps",
      "pm_gravity",
      "pm_max_wall_jumps",
      "sensitivity",
      "sv_hostname",
    ]);
    expect(cvars.list("pm_").map((c) => c.def.name)).toEqual(["pm_gravity", "pm_max_wall_jumps"]);
  });

  it("returns the REPLICATED cvars sorted by name", () => {
    expect(cvars.replicated().map((c) => c.def.name)).toEqual(["pm_gravity", "pm_max_wall_jumps"]);
  });
});
