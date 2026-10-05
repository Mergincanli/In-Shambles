import { HULL_MINS, type Triple } from "@game/shared";
import { GreyboxError } from "../brushCompiler";
import { MATERIAL_FLOOR, type MapBuilder } from "../MapBuilder";

/**
 * Helpers the greybox courses share (docs/07 §3). Course dimensions are design values of ours,
 * not ESTIMATEs of the original game; the ones that matter are commented where they are set.
 */

/** The second floor grey: alternating tiles mark distance and put coplanar seams underfoot. */
export const MATERIAL_FLOOR_ALT = "grey/floor_alt";

/**
 * Origin height above the ground for a player whose feet touch it: −mins.z of both hulls
 * (docs/03 §2). Touching counts as outside (D-017), so a spawn or anchor there is clear.
 */
export const FEET_TO_ORIGIN = -HULL_MINS[2];

/**
 * Where a player stands with feet on the ground at `groundZ`: every anchor and spawn is such a
 * spot, so tests can put a hull there directly. A ground that is not on the 1/32 u grid (a slope
 * crest's f32 top) is rounded up to it, which leaves the feet less than 1/32 u above.
 */
export function stand(x: number, y: number, groundZ: number): Triple {
  return [x, y, Math.ceil(groundZ * 32) / 32 + FEET_TO_ORIGIN];
}

export interface FloorTilesOptions {
  /** The xy rectangle the tiles cover. */
  readonly min: readonly [number, number];
  readonly max: readonly [number, number];
  /** Tiles are `tile` long along this axis and span the rectangle across it. */
  readonly axis: 0 | 1;
  readonly tile: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * A floor of strips `tile` wide along `axis`, alternating MATERIAL_FLOOR and MATERIAL_FLOOR_ALT:
 * distance markers that also put a coplanar seam under the player every `tile` units, which a
 * box sliding across must not snag on.
 */
export function floorTiles(m: MapBuilder, options: FloorTilesOptions): void {
  const { min, max, axis, tile, top, bottom } = options;
  const count = (max[axis] - min[axis]) / tile;
  if (!Number.isInteger(count) || count < 1) {
    throw new GreyboxError(`${m.name}: floor tiles of ${tile} u do not divide the floor`);
  }
  for (let i = 0; i < count; i++) {
    const lo: [number, number, number] = [min[0], min[1], bottom];
    const hi: [number, number, number] = [max[0], max[1], top];
    lo[axis] = min[axis] + i * tile;
    hi[axis] = min[axis] + (i + 1) * tile;
    m.box({ min: lo, max: hi, material: i % 2 === 0 ? MATERIAL_FLOOR : MATERIAL_FLOOR_ALT });
  }
}

/**
 * A floor slab over the xy rectangle `outer` with the rectangle `hole` left open, as up to four
 * boxes (the strips south and north of the hole, then west and east of it). A thick slab makes
 * the walls of a pit dug into the hole.
 */
export function floorAround(
  m: MapBuilder,
  outerMin: readonly [number, number],
  outerMax: readonly [number, number],
  holeMin: readonly [number, number],
  holeMax: readonly [number, number],
  top: number,
  bottom: number,
): void {
  const [x0, y0] = outerMin;
  const [x1, y1] = outerMax;
  const [hx0, hy0] = holeMin;
  const [hx1, hy1] = holeMax;
  if (!(x0 <= hx0 && hx0 < hx1 && hx1 <= x1 && y0 <= hy0 && hy0 < hy1 && hy1 <= y1)) {
    throw new GreyboxError(`${m.name}: floor hole is not inside the floor`);
  }
  if (y0 < hy0) m.box({ min: [x0, y0, bottom], max: [x1, hy0, top] });
  if (hy1 < y1) m.box({ min: [x0, hy1, bottom], max: [x1, y1, top] });
  if (x0 < hx0) m.box({ min: [x0, hy0, bottom], max: [hx0, hy1, top] });
  if (hx1 < x1) m.box({ min: [hx1, hy0, bottom], max: [x1, hy1, top] });
}

/**
 * A pit section in a hole of a floor slab: a solid bottom `depth` below the floor top, down to
 * the slab's bottom, and water from it up to the floor top.
 */
export function pool(
  m: MapBuilder,
  min: readonly [number, number],
  max: readonly [number, number],
  top: number,
  bottom: number,
  depth: number,
): void {
  m.box({ min: [min[0], min[1], bottom], max: [max[0], max[1], top - depth] });
  m.volume("WATER", { min: [min[0], min[1], top - depth], max: [max[0], max[1], top] });
}
