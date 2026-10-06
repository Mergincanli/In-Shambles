import type { Cmap } from "@game/shared";
import { MapBuilder } from "../MapBuilder";
import { floorAround, pool, stand } from "./common";

/**
 * fall_tower (docs/07 §3): fall-damage fixtures. A row of pillars whose tops are the drop
 * platforms, each with a ladder up its north face and a dry landing south of it; a water pool at
 * the foot of the tallest; and a tall wall with ledge-grab catch rails.
 */

/** docs/07 §3 platform heights above the floor. */
const PLATFORMS = [128, 256, 384, 512, 640, 768, 1024] as const;
const PILLAR_PITCH = 256;
const PILLAR_SIZE = 128;

/** Floor slab, thick enough for the pool pit. */
const FLOOR_MIN: readonly [number, number] = [-1280, -1024];
const FLOOR_MAX: readonly [number, number] = [2560, 1024];
const FLOOR_BOTTOM = -160;

/**
 * Landing pool beside the 1024 u pillar: 128 u deep, so a lander is fully under water (level 3;
 * docs/03 §5.6 waives fall damage at level 2 and above).
 */
const POOL_DEPTH = 128;
const POOL_X0 = 1664;
const POOL_X1 = 2176;
const POOL_HALF_WIDTH = 256;

/**
 * Catch rails on the wall's south face, each in its own column so the wall top above it is a
 * clear drop: rail_256 catches a fall of 768 u (docs/03 §8 MV-13). 32 u deep, so a crouched hull
 * (30 u) fits on top for the ledge-grab space probe (docs/03 §5.5). 64 u tall: the chest probe
 * (feet + 40) can see a rail whose top is 24…76 u above the feet (pm_ledgeMin/MaxHeight,
 * ESTIMATE), a 36 u window in feet height when the face is at least that tall, about two ticks of
 * fall at the 1110 u/s a 768 u drop reaches, so a once-per-tick probe cannot skip it.
 */
const RAILS = [256, 512, 768] as const;
const RAIL_DEPTH = 32;
const RAIL_HEIGHT = 64;
const RAIL_HALF_WIDTH = 64;
const RAIL_PITCH = 256;
const RAIL_WALL_X0 = -1024;
const RAIL_WALL_HEIGHT = 1024;

export function fallTower(): Cmap {
  const m = new MapBuilder("fall_tower");
  floorAround(
    m,
    FLOOR_MIN,
    FLOOR_MAX,
    [POOL_X0, -POOL_HALF_WIDTH],
    [POOL_X1, POOL_HALF_WIDTH],
    0,
    FLOOR_BOTTOM,
  );
  pool(m, [POOL_X0, -POOL_HALF_WIDTH], [POOL_X1, POOL_HALF_WIDTH], 0, FLOOR_BOTTOM, POOL_DEPTH);
  m.spawn("info_player_start", stand(0, -512, 0), 90);

  // Pillars along +x; the last one's east face is the pool's west wall.
  for (let i = 0; i < PLATFORMS.length; i++) {
    const h = PLATFORMS[i] as number;
    const x0 = POOL_X0 - PILLAR_SIZE - (PLATFORMS.length - 1 - i) * PILLAR_PITCH;
    const x = x0 + PILLAR_SIZE / 2;
    m.ladder({ wallMin: [x0, 0, 0], wallMax: [x0 + PILLAR_SIZE, PILLAR_SIZE, h], face: "+y" });
    m.anchor(`platform_${h}_top`, stand(x, PILLAR_SIZE / 2, h), -90);
    m.anchor(`platform_${h}_landing`, stand(x, -96, 0), -90);
  }
  m.anchor("pool_landing", stand((POOL_X0 + POOL_X1) / 2, 0, -POOL_DEPTH), 0);

  // The rail wall, with a ladder up its north face and a drop spot on its top above each rail.
  const wallX1 = RAIL_WALL_X0 + RAILS.length * RAIL_PITCH;
  m.ladder({ wallMin: [RAIL_WALL_X0, 0, 0], wallMax: [wallX1, 64, RAIL_WALL_HEIGHT], face: "+y" });
  for (let i = 0; i < RAILS.length; i++) {
    const h = RAILS[i] as number;
    const railX = RAIL_WALL_X0 + RAIL_PITCH / 2 + i * RAIL_PITCH;
    m.box({
      min: [railX - RAIL_HALF_WIDTH, -RAIL_DEPTH, h - RAIL_HEIGHT],
      max: [railX + RAIL_HALF_WIDTH, 0, h],
    });
    m.anchor(`rail_${h}_top`, stand(railX, -RAIL_DEPTH / 2, h), 90);
    m.anchor(`rail_${h}_drop`, stand(railX, 32, RAIL_WALL_HEIGHT), -90);
  }

  return m.compile();
}
