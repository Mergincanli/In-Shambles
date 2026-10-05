import { describe, expect, it } from "vitest";
import {
  CONTENTS_KNOWN,
  CONTENTS_LADDER,
  CONTENTS_NODAMAGE,
  CONTENTS_NODRAW,
  CONTENTS_PLAYERCLIP,
  CONTENTS_SLICK,
  CONTENTS_SOLID,
  CONTENTS_TRIGGER,
  CONTENTS_WATER,
  FOOTSTEP_CONCRETE,
  FOOTSTEP_COUNT,
  FOOTSTEP_DEFAULT,
  FOOTSTEP_GRASS,
  FOOTSTEP_METAL,
  FOOTSTEP_WATER,
  FOOTSTEP_WOOD,
  MASK_PLAYERSOLID,
  MASK_SOLID,
  MASK_WATER,
  SURF_FOOTSTEP_MASK,
  SURF_KNOWN,
  SURF_LADDER,
  SURF_NODAMAGE,
  SURF_SLICK,
  surfaceFootstep,
  surfaceWithFootstep,
} from "../../src/world/contents";

const CONTENTS = [
  CONTENTS_SOLID,
  CONTENTS_PLAYERCLIP,
  CONTENTS_WATER,
  CONTENTS_LADDER,
  CONTENTS_SLICK,
  CONTENTS_NODAMAGE,
  CONTENTS_TRIGGER,
  CONTENTS_NODRAW,
];

describe("contents (docs/07 §2)", () => {
  it("gives each of the eight contents its own bit, and KNOWN is exactly their union", () => {
    expect(new Set(CONTENTS).size).toBe(8);
    for (const c of CONTENTS) expect(c & (c - 1)).toBe(0);
    expect(CONTENTS.reduce((a, c) => a | c, 0)).toBe(CONTENTS_KNOWN);
  });

  it("pins the docs/07 §2 bit values (file format)", () => {
    expect(CONTENTS).toEqual([1, 2, 4, 8, 16, 32, 64, 128]);
    expect([SURF_LADDER, SURF_SLICK, SURF_NODAMAGE]).toEqual([1, 2, 4]);
    expect(SURF_FOOTSTEP_MASK).toBe(0xf00);
    expect(surfaceWithFootstep(0, FOOTSTEP_WATER)).toBe(0x500);
    expect(SURF_KNOWN).toBe(0xf07);
  });

  it("defines the trace masks", () => {
    expect(MASK_PLAYERSOLID).toBe(CONTENTS_SOLID | CONTENTS_PLAYERCLIP);
    expect(MASK_SOLID).toBe(CONTENTS_SOLID);
    expect(MASK_WATER).toBe(CONTENTS_WATER);
    expect(MASK_SOLID & CONTENTS_PLAYERCLIP).toBe(0);
  });
});

describe("surface flags", () => {
  it("keeps the flag bits clear of the footstep field", () => {
    const flags = [SURF_LADDER, SURF_SLICK, SURF_NODAMAGE];
    expect(new Set(flags).size).toBe(3);
    for (const f of flags) expect(f & SURF_FOOTSTEP_MASK).toBe(0);
    expect(SURF_KNOWN).toBe(SURF_LADDER | SURF_SLICK | SURF_NODAMAGE | SURF_FOOTSTEP_MASK);
  });

  it("packs every footstep material into the field and back", () => {
    const materials = [
      FOOTSTEP_DEFAULT,
      FOOTSTEP_CONCRETE,
      FOOTSTEP_METAL,
      FOOTSTEP_WOOD,
      FOOTSTEP_GRASS,
      FOOTSTEP_WATER,
    ];
    expect(materials).toEqual([0, 1, 2, 3, 4, 5]);
    expect(FOOTSTEP_COUNT).toBe(materials.length);
    for (const m of materials) {
      const flags = surfaceWithFootstep(SURF_LADDER | SURF_NODAMAGE, m);
      expect(surfaceFootstep(flags)).toBe(m);
      expect(flags & ~SURF_FOOTSTEP_MASK).toBe(SURF_LADDER | SURF_NODAMAGE);
      expect(flags & ~SURF_KNOWN).toBe(0);
    }
    expect(surfaceWithFootstep(surfaceWithFootstep(0, FOOTSTEP_WOOD), FOOTSTEP_METAL)).toBe(
      surfaceWithFootstep(0, FOOTSTEP_METAL),
    );
  });
});
