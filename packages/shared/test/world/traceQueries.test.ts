import { afterEach, describe, expect, it } from "vitest";
import { setDevAsserts } from "../../src/debug/assert";
import { vec3 } from "../../src/math/vec3";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { HULL_MINS, HULL_STANDING_MAXS } from "../../src/sim/hull";
import {
  CONTENTS_LADDER,
  CONTENTS_PLAYERCLIP,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  MASK_PLAYERSOLID,
  MASK_WATER,
} from "../../src/world/contents";
import { boxPlanes, rotatedBoxPlanes } from "../../src/world/shapes";
import { boxContents, pointContents, positionContents, positionTest } from "../../src/world/trace";
import { brush, worldOf } from "../helpers/traceWorld";

const v = vec3;
const MINS = HULL_MINS;
const MAXS = HULL_STANDING_MAXS;

const world = worldOf(
  brush(boxPlanes([-512, -512, -64], [512, 512, 0])),
  // A 36 u deep pool on the floor, with a ladder volume overlapping its corner.
  brush(boxPlanes([-128, -128, 0], [128, 128, 36]), CONTENTS_WATER),
  brush(boxPlanes([112, -16, 0], [128, 16, 256]), CONTENTS_LADDER),
  brush(boxPlanes([300, -64, 0], [364, 64, 128]), CONTENTS_PLAYERCLIP),
  brush(rotatedBoxPlanes([-300, 0, 64], [64, 16, 64], Math.SQRT1_2, Math.SQRT1_2)),
);

describe("pointContents", () => {
  it("ORs the contents of brushes strictly containing the point", () => {
    expect(pointContents(world, v(0, 0, 10))).toBe(CONTENTS_WATER);
    expect(pointContents(world, v(120, 0, 10))).toBe(CONTENTS_WATER | CONTENTS_LADDER);
    expect(pointContents(world, v(120, 0, 100))).toBe(CONTENTS_LADDER);
    expect(pointContents(world, v(0, 0, -1))).toBe(CONTENTS_SOLID);
    expect(pointContents(world, v(0, 0, 100))).toBe(0);
    expect(pointContents(world, v(320, 0, 64))).toBe(CONTENTS_PLAYERCLIP);
  });

  it("a point on a surface is outside", () => {
    expect(pointContents(world, v(0, 0, 36))).toBe(0);
    expect(pointContents(world, v(0, 0, 36 - 1 / 1024))).toBe(CONTENTS_WATER);
    // On the floor top, which is also the pool's bottom: inside neither.
    expect(pointContents(world, v(0, 0, 0))).toBe(0);
    expect(pointContents(world, v(600, 0, 0))).toBe(0);
  });

  it("samples feet, waist and eyes for the water level (docs/03 §4.13)", () => {
    // Standing in the 36 u pool: feet at 1/32, waist at 24 + 1/32, eyes at 50 + 1/32.
    const z = 24 + 1 / 32;
    const level = [z - 24 + 1, z, z + 26].filter(
      (h) => (pointContents(world, v(0, 0, h)) & MASK_WATER) !== 0,
    ).length;
    expect(level).toBe(2);
  });
});

describe("boxContents", () => {
  it("ORs the contents of brushes whose interior overlaps the box", () => {
    expect(boxContents(world, v(100, -8, 40), v(116, 8, 80))).toBe(CONTENTS_LADDER);
    expect(boxContents(world, v(100, -8, 20), v(116, 8, 80))).toBe(
      CONTENTS_LADDER | CONTENTS_WATER,
    );
    expect(boxContents(world, v(-10, -10, -10), v(10, 10, 10))).toBe(
      CONTENTS_SOLID | CONTENTS_WATER,
    );
  });

  it("boxes that only touch don't overlap", () => {
    expect(boxContents(world, v(96, -8, 40), v(112, 8, 80))).toBe(0);
    expect(boxContents(world, v(0, 0, 36), v(10, 10, 50))).toBe(0);
  });

  it("touching stays outside for bounds off the binary grid", () => {
    // Center/half-extent arithmetic rounds for these values; the corner test does not.
    const rng = new Mulberry32(0xb0c5);
    for (let i = 0; i < 2000; i++) {
      const wall = Math.fround((rng.nextFloat() * 2 - 1) * 4000);
      const lo = wall - 1 - rng.nextFloat() * 50;
      const w = worldOf(brush(boxPlanes([wall, -64, -64], [Math.fround(wall + 64), 64, 64])));
      expect(boxContents(w, v(lo, -10, -10), v(wall, 10, 10))).toBe(0);
      expect(boxContents(w, v(lo, -10, -10), v(wall + 1 / 1024, 10, 10))).toBe(CONTENTS_SOLID);
    }
    const wall = -33.76736831665039;
    const w = worldOf(brush(boxPlanes([wall, -64, -64], [wall + 64, 64, 64])));
    expect(boxContents(w, v(-48.17287947166711, -10, -10), v(wall, 10, 10))).toBe(0);
  });

  it("is exact against a 45° box (axial bevels)", () => {
    // The rotated box's +x tip is its local corner (u, v) = (64, −16).
    const tipX = -300 + (64 + 16) * Math.SQRT1_2;
    const tipY = (64 - 16) * Math.SQRT1_2;
    expect(boxContents(world, v(tipX + 0.5, tipY - 2, 60), v(tipX + 4, tipY + 2, 70))).toBe(0);
    expect(boxContents(world, v(tipX - 1, tipY - 0.25, 60), v(tipX + 4, tipY + 0.25, 70))).toBe(
      CONTENTS_SOLID,
    );
  });
});

describe("positionTest and positionContents", () => {
  afterEach(() => setDevAsserts(true));

  it("only masked brushes block", () => {
    const inPool = v(0, 0, 24 + 1 / 32);
    expect(positionTest(world, inPool, MINS, MAXS, MASK_PLAYERSOLID)).toBe(true);
    expect(positionTest(world, inPool, MINS, MAXS, MASK_WATER)).toBe(false);
    expect(positionContents(world, inPool, MINS, MAXS, MASK_PLAYERSOLID)).toBe(0);
    expect(positionContents(world, v(120, 0, 30), MINS, MAXS, -1)).toBe(
      CONTENTS_WATER | CONTENTS_LADDER,
    );
    expect(positionContents(world, v(340, 0, 100), MINS, MAXS, MASK_PLAYERSOLID)).toBe(
      CONTENTS_PLAYERCLIP,
    );
  });

  it("bad input never reads as clear", () => {
    setDevAsserts(false);
    const nan = v(Number.NaN, 0, 0);
    expect(positionTest(world, nan, MINS, MAXS, MASK_PLAYERSOLID)).toBe(false);
    expect(positionContents(world, nan, MINS, MAXS, MASK_PLAYERSOLID)).not.toBe(0);
    expect(positionTest(world, v(0, 0, 1e9), MINS, MAXS, MASK_PLAYERSOLID)).toBe(false);
  });

  it("agrees with positionContents === 0", () => {
    for (let x = -400; x <= 400; x += 37) {
      for (let z = 0; z <= 120; z += 23) {
        const p = v(x, x * 0.3, z);
        expect(positionTest(world, p, MINS, MAXS, MASK_PLAYERSOLID)).toBe(
          positionContents(world, p, MINS, MAXS, MASK_PLAYERSOLID) === 0,
        );
      }
    }
  });
});
