import { describe, expect, it } from "vitest";
import {
  HULL_CROUCHED_MAXS,
  HULL_MINS,
  HULL_STANDING_MAXS,
  VIEW_HEIGHT_CROUCHED,
  VIEW_HEIGHT_STANDING,
  WATER_SAMPLE_FEET,
  WATER_SAMPLE_WAIST,
} from "../../src/sim/hull";

describe("player hulls (docs/03 §2)", () => {
  it("match the spec table", () => {
    expect([...HULL_MINS]).toEqual([-15, -15, -24]);
    expect([...HULL_STANDING_MAXS]).toEqual([15, 15, 32]);
    expect([...HULL_CROUCHED_MAXS]).toEqual([15, 15, 16]);
  });

  it("are 30 u wide, 56 u standing and 40 u crouched", () => {
    expect(HULL_STANDING_MAXS[0] - HULL_MINS[0]).toBe(30);
    expect(HULL_STANDING_MAXS[1] - HULL_MINS[1]).toBe(30);
    expect(HULL_STANDING_MAXS[2] - HULL_MINS[2]).toBe(56);
    expect(HULL_CROUCHED_MAXS[2] - HULL_MINS[2]).toBe(40);
  });

  it("are Float64Array vectors", () => {
    for (const v of [HULL_MINS, HULL_STANDING_MAXS, HULL_CROUCHED_MAXS]) {
      expect(v).toBeInstanceOf(Float64Array);
      expect(v).toHaveLength(3);
    }
  });
});

describe("view heights (docs/03 §2)", () => {
  it("put the eye 50 u above the feet standing and 36 u crouched", () => {
    expect(VIEW_HEIGHT_STANDING).toBe(26);
    expect(VIEW_HEIGHT_CROUCHED).toBe(12);
    expect(VIEW_HEIGHT_STANDING - HULL_MINS[2]).toBe(50);
    expect(VIEW_HEIGHT_CROUCHED - HULL_MINS[2]).toBe(36);
  });

  it("stay inside their hulls", () => {
    expect(VIEW_HEIGHT_STANDING).toBeLessThan(HULL_STANDING_MAXS[2]);
    expect(VIEW_HEIGHT_CROUCHED).toBeLessThan(HULL_CROUCHED_MAXS[2]);
  });
});

describe("water samples (M2 design D-024)", () => {
  it("sit at feet + 1 and the middle of the standing hull, below both eyes", () => {
    expect(WATER_SAMPLE_FEET).toBe(1);
    expect(WATER_SAMPLE_WAIST).toBe(28);
    expect(WATER_SAMPLE_WAIST * 2).toBe(HULL_STANDING_MAXS[2] - HULL_MINS[2]);
    expect(WATER_SAMPLE_FEET).toBeLessThan(WATER_SAMPLE_WAIST);
    expect(WATER_SAMPLE_WAIST).toBeLessThan(VIEW_HEIGHT_CROUCHED - HULL_MINS[2]);
  });
});
