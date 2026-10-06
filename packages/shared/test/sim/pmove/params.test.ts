import { describe, expect, it, vi } from "vitest";
import { CvarFlag, CvarRegistry } from "../../../src/cvars";
import {
  PMOVE_CVARS,
  PmoveParams,
  refreshPmoveParams,
  registerPmoveCvars,
} from "../../../src/sim/pmove/params";

function registry(): CvarRegistry {
  const reg = new CvarRegistry();
  registerPmoveCvars(reg);
  return reg;
}

describe("PMOVE_CVARS", () => {
  it("has one row per PmoveParams field, with the field's default", () => {
    const params = new PmoveParams();
    const fields = Object.keys(params).filter((k) => k !== "version" && k !== "registry");
    expect(PMOVE_CVARS.map((r) => r.field).sort()).toEqual([...fields].sort());
    for (const r of PMOVE_CVARS) expect(params[r.field], r.name).toBe(r.default);
  });

  it("names every row pm_<field> and keeps names unique", () => {
    for (const r of PMOVE_CVARS) expect(r.name).toBe(`pm_${r.field}`);
    expect(new Set(PMOVE_CVARS.map((r) => r.name.toLowerCase())).size).toBe(PMOVE_CVARS.length);
  });

  it("keeps every default inside its bounds and labels every row", () => {
    for (const r of PMOVE_CVARS) {
      expect(r.min, r.name).toBeLessThanOrEqual(r.default);
      expect(r.default, r.name).toBeLessThanOrEqual(r.max);
      expect(["FACT-Q3", "FACT", "INFERRED", "ESTIMATE"]).toContain(r.label);
      expect(r.description.length, r.name).toBeGreaterThan(0);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(PMOVE_CVARS)).toBe(true);
    for (const r of PMOVE_CVARS) expect(Object.isFrozen(r)).toBe(true);
  });

  it("keeps the overclip at least 1, so a clip never points into a plane", () => {
    const overclip = PMOVE_CVARS.find((r) => r.name === "pm_overclip");
    expect(overclip?.min).toBe(1);
  });
});

describe("registerPmoveCvars", () => {
  it("registers every row as REPLICATED with its bounds", () => {
    const reg = registry();
    expect(reg.replicated().map((c) => c.def.name)).toEqual(
      PMOVE_CVARS.map((r) => r.name).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)),
    );
    for (const r of PMOVE_CVARS) {
      const info = reg.info(r.name);
      expect(info?.value, r.name).toBe(r.default);
      expect(info?.def).toMatchObject({ type: r.type, min: r.min, max: r.max });
      expect(info?.def.flags).toBe(CvarFlag.REPLICATED);
    }
  });

  it("clamps out-of-range sets to the bounds", () => {
    const reg = registry();
    expect(reg.set("pm_overclip", 0.5)).toMatchObject({ ok: true, value: 1, clamped: true });
    expect(reg.set("pm_autoHop", 1.5)).toEqual({ ok: false, error: "type" });
  });
});

describe("refreshPmoveParams", () => {
  it("refreshes a fresh PmoveParams once, then not while the version is unchanged", () => {
    const reg = registry();
    const params = new PmoveParams();
    expect(refreshPmoveParams(reg, params)).toBe(true);
    expect(params.version).toBe(reg.version);
    expect(refreshPmoveParams(reg, params)).toBe(false);
    reg.set("pm_gravity", 800); // same value: no change
    expect(refreshPmoveParams(reg, params)).toBe(false);
  });

  it("does not read the registry when the version is unchanged", () => {
    const reg = registry();
    const params = new PmoveParams();
    refreshPmoveParams(reg, params);
    const get = vi.spyOn(reg, "get");
    const getNumber = vi.spyOn(reg, "getNumber");
    try {
      expect(refreshPmoveParams(reg, params)).toBe(false);
      expect(get).not.toHaveBeenCalled();
      expect(getNumber).not.toHaveBeenCalled();
      params.version = -1;
      expect(refreshPmoveParams(reg, params)).toBe(true);
      expect(getNumber).toHaveBeenCalledTimes(PMOVE_CVARS.length);
    } finally {
      get.mockRestore();
      getNumber.mockRestore();
    }
  });

  it("picks up a set, a reset and a string set", () => {
    const reg = registry();
    const params = new PmoveParams();
    refreshPmoveParams(reg, params);
    reg.set("pm_gravity", 400);
    expect(params.gravity).toBe(800);
    expect(refreshPmoveParams(reg, params)).toBe(true);
    expect(params.gravity).toBe(400);
    reg.setFromString("PM_AUTOHOP", "1");
    reg.set("pm_ladderReach", 4.5);
    expect(refreshPmoveParams(reg, params)).toBe(true);
    expect(params.autoHop).toBe(1);
    expect(params.ladderReach).toBe(4.5);
    reg.reset("pm_gravity");
    expect(refreshPmoveParams(reg, params)).toBe(true);
    expect(params.gravity).toBe(800);
    expect(params.version).toBe(reg.version);
  });

  it("copies every cvar into its own field", () => {
    const reg = registry();
    // A distinct value per row, so a store into the wrong field shows up.
    PMOVE_CVARS.forEach((r, i) => {
      const value = r.type === "int" ? r.max : r.min + ((r.max - r.min) * (i + 1)) / (i + 40);
      expect(reg.set(r.name, value), r.name).toMatchObject({ ok: true, clamped: false });
    });
    const values = PMOVE_CVARS.map((r) => reg.get(r.name));
    expect(new Set(values).size).toBe(PMOVE_CVARS.length);
    const params = new PmoveParams();
    refreshPmoveParams(reg, params);
    for (const r of PMOVE_CVARS) expect(params[r.field], r.name).toBe(reg.get(r.name));
  });

  it("refreshes from a different registry at the same version", () => {
    const a = registry();
    const b = registry();
    a.set("pm_gravity", 400);
    b.set("pm_runSpeed", 250);
    expect(a.version).toBe(b.version);
    const params = new PmoveParams();
    expect(refreshPmoveParams(a, params)).toBe(true);
    expect(params.gravity).toBe(400);
    expect(refreshPmoveParams(b, params)).toBe(true);
    expect(params.gravity).toBe(800);
    expect(params.runSpeed).toBe(250);
    expect(params.registry).toBe(b);
    expect(refreshPmoveParams(b, params)).toBe(false);
  });

  it("falls back to the defaults for cvars the registry lacks", () => {
    const reg = new CvarRegistry();
    reg.register({ name: "pm_gravity", type: "float", default: 600, description: "x" });
    const params = new PmoveParams();
    params.runSpeed = 1;
    expect(refreshPmoveParams(reg, params)).toBe(true);
    expect(params.gravity).toBe(600);
    expect(params.runSpeed).toBe(320);
  });

  it("keeps two PmoveParams in step with one registry independently", () => {
    const reg = registry();
    const a = new PmoveParams();
    const b = new PmoveParams();
    refreshPmoveParams(reg, a);
    reg.set("pm_friction", 4);
    expect(refreshPmoveParams(reg, a)).toBe(true);
    expect(refreshPmoveParams(reg, b)).toBe(true);
    expect(a.friction).toBe(4);
    expect(b.friction).toBe(4);
  });
});
