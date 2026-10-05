/**
 * Brush contents (docs/07 §2): what a whole brush is. Traces and position tests take a mask and
 * only see brushes whose contents intersect it. The bit values are ours; cmap stores them as u32.
 */
export const CONTENTS_SOLID = 1 << 0;
/** Blocks players only (invisible clip brushes, `tool/clip` in docs/07 §4.1). */
export const CONTENTS_PLAYERCLIP = 1 << 1;
export const CONTENTS_WATER = 1 << 2;
export const CONTENTS_LADDER = 1 << 3;
export const CONTENTS_SLICK = 1 << 4;
export const CONTENTS_NODAMAGE = 1 << 5;
export const CONTENTS_TRIGGER = 1 << 6;
export const CONTENTS_NODRAW = 1 << 7;

/** Every defined contents bit; loaders reject anything else. */
export const CONTENTS_KNOWN = 0xff;

/** What stops a player's hull. */
export const MASK_PLAYERSOLID = CONTENTS_SOLID | CONTENTS_PLAYERCLIP;
/** What stops shots and other non-player traces. */
export const MASK_SOLID = CONTENTS_SOLID;
/** What counts for water level (docs/03 §4.13). */
export const MASK_WATER = CONTENTS_WATER;

/**
 * Surface flags, one u32 per brush side (docs/07 §2 "optional surfaceFlags per side"). A trace
 * reports the hit side's flags, so the ground trace can read slick, ladder and nodamage from the
 * surface it stands on (docs/03 §4.10, §4.14, §5.6). Bevel sides carry 0.
 */
export const SURF_LADDER = 1 << 0;
export const SURF_SLICK = 1 << 1;
export const SURF_NODAMAGE = 1 << 2;

/**
 * Bits 8–11 hold the footstep material (docs/07 §6: chosen by texture name prefix). 0 is the
 * default sound for surfaces without a prefix.
 */
export const SURF_FOOTSTEP_SHIFT = 8;
export const SURF_FOOTSTEP_MASK = 0xf << SURF_FOOTSTEP_SHIFT;
export const FOOTSTEP_DEFAULT = 0;
export const FOOTSTEP_CONCRETE = 1;
export const FOOTSTEP_METAL = 2;
export const FOOTSTEP_WOOD = 3;
export const FOOTSTEP_GRASS = 4;
export const FOOTSTEP_WATER = 5;
export const FOOTSTEP_COUNT = 6;

/** Every defined surface bit, including the whole footstep field; loaders reject anything else. */
export const SURF_KNOWN = SURF_LADDER | SURF_SLICK | SURF_NODAMAGE | SURF_FOOTSTEP_MASK;

export function surfaceFootstep(surfaceFlags: number): number {
  return (surfaceFlags & SURF_FOOTSTEP_MASK) >>> SURF_FOOTSTEP_SHIFT;
}

/** Replaces the footstep field. `footstep` must be 0…FOOTSTEP_COUNT − 1. */
export function surfaceWithFootstep(surfaceFlags: number, footstep: number): number {
  return ((surfaceFlags & ~SURF_FOOTSTEP_MASK) | (footstep << SURF_FOOTSTEP_SHIFT)) >>> 0;
}
