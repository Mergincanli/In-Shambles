import { describe, expect, it } from "vitest";
import { HULL_CROUCHED_MAXS, HULL_MINS, HULL_STANDING_MAXS } from "../../src/sim/hull";

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
