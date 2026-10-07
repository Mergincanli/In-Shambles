import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CvarFlag, CvarRegistry } from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  refreshViewSettings,
  registerViewCvars,
  VIEW_CVARS,
  ViewSettings,
} from "../../src/render/viewCvars";

const docUrl = new URL("../../../../docs/06-engine-architecture.md", import.meta.url);
const doc = readFileSync(fileURLToPath(docUrl), "utf8");

/** The default the docs/06 §7 client cvar table gives `name`. */
function docDefault(name: string): number {
  const row = new RegExp(`^\\| \`${name}\` \\| ([0-9.]+)[^|]*\\|`, "m").exec(doc);
  if (row === null) throw new Error(`docs/06 has no row for ${name}`);
  return Number(row[1]);
}

describe("view cvars (docs/06 §7)", () => {
  it("registers ARCHIVE cvars with the documented defaults, matching ViewSettings' fallbacks", () => {
    const reg = new CvarRegistry();
    registerViewCvars(reg);
    const fresh = new ViewSettings();
    const fallback: Record<string, number> = {
      cl_fov: fresh.fov,
      cl_stepSmoothMs: fresh.stepSmoothMs,
      cl_viewHeightSmoothMs: fresh.viewHeightSmoothMs,
    };
    expect(VIEW_CVARS.map((c) => c.name)).toEqual(Object.keys(fallback));
    for (const c of VIEW_CVARS) {
      const flags = reg.info(c.name)?.def.flags ?? 0;
      expect(reg.has(c.name), c.name).toBe(true);
      expect((flags & CvarFlag.ARCHIVE) !== 0, c.name).toBe(true);
      expect((flags & CvarFlag.REPLICATED) !== 0, c.name).toBe(false);
      expect(reg.getNumber(c.name, Number.NaN), c.name).toBe(docDefault(c.name));
      expect(fallback[c.name], c.name).toBe(docDefault(c.name));
    }
  });

  it("refreshes the settings when the registry changes, and only then", () => {
    const reg = new CvarRegistry();
    registerViewCvars(reg);
    const s = new ViewSettings();
    expect(refreshViewSettings(reg, s)).toBe(true);
    expect([s.fov, s.stepSmoothMs, s.viewHeightSmoothMs]).toEqual([90, 150, 100]);
    expect(refreshViewSettings(reg, s)).toBe(false);
    reg.setFromString("cl_fov", "100");
    reg.setFromString("cl_stepSmoothMs", "0");
    reg.set("cl_viewHeightSmoothMs", 250);
    expect(refreshViewSettings(reg, s)).toBe(true);
    expect([s.fov, s.stepSmoothMs, s.viewHeightSmoothMs]).toEqual([100, 0, 250]);
    expect(refreshViewSettings(reg, s)).toBe(false);
  });
});
