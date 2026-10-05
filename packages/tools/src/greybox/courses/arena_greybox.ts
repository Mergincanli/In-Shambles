import type { Cmap, Triple } from "@game/shared";
import { MapBuilder } from "../MapBuilder";
import { stand } from "./common";

/**
 * arena_greybox (docs/07 §3): a small combat map for netcode and combat tests. A walled
 * 3072 × 2048 u yard with a team base room at each end, a raised centre platform with ramps, a
 * covered corridor, a stepped ledge on the south wall and scattered cover. 16 free-for-all spawns
 * in the yard, 8 per team inside the bases. Doors and corridors keep docs/07 §6's sizes.
 */

const HALF_X = 1536;
const HALF_Y = 1024;
const WALL_THICKNESS = 32;
const WALL_HEIGHT = 256;

/** Base rooms span this much of each end, inner wall included; the door is in the inner wall. */
const BASE_DEPTH = 480;
const BASE_HALF_WIDTH = 512;
/** Doors: 96 × 128 u, over docs/07 §6's 48 × 96 minimum. */
const DOOR_HALF_WIDTH = 48;
const DOOR_HEIGHT = 128;

/**
 * Centre platform: 512 × 512 u, 128 u up, ramps north and south (normal.z ≈ 0.89). The north
 * ramp's foot is 176 u short of the corridor, well over docs/07 §6's 64 u passing width.
 */
const CENTER_HALF = 256;
const CENTER_TOP = 128;
const RAMP_RUN = 256;

/** Covered corridor: 128 u wide inside (docs/07 §6: at least 64), 128 u tall. */
const CORRIDOR_HALF_LENGTH = 640;
const CORRIDOR_Y0 = 704;
const CORRIDOR_Y1 = 832;
const CORRIDOR_HEIGHT = 128;

/** South ledge: 96 u up, reached by 6 steps of 16 u. */
const LEDGE_TOP = 96;

/** Free-for-all spawns: [x, y, yaw], all on the yard floor and clear of cover. */
const FFA_SPAWNS: readonly (readonly [number, number, number])[] = [
  [-896, -768, 45],
  [-896, 768, -45],
  [896, -768, 135],
  [896, 768, -135],
  [-640, -320, 0],
  [-640, 320, 0],
  [640, -320, 180],
  [640, 320, 180],
  [-384, 384, -45],
  [384, 384, -135],
  [-384, -384, 45],
  [384, -384, 135],
  [-896, 0, 0],
  [896, 0, 180],
  [0, 896, -90],
  [0, -800, 90],
];

/** Team spawns: a 2 × 4 grid inside the base, for the west (red) base; blue mirrors x. */
const TEAM_SPAWN_X = [-1408, -1216] as const;
const TEAM_SPAWN_Y = [-384, -128, 128, 384] as const;

function box(m: MapBuilder, min: Triple, max: Triple): void {
  m.box({ min, max });
}

function wall(m: MapBuilder, min: Triple, max: Triple): void {
  m.wall({ min, max });
}

/**
 * A base room at one end (`side` −1 west, +1 east): an inner wall with a door, its yard face
 * BASE_DEPTH from the outer wall's inside, and side walls from it to the outer wall.
 */
function base(m: MapBuilder, side: number): void {
  const inner = side * (HALF_X - BASE_DEPTH);
  const lo = Math.min(inner, inner + side * WALL_THICKNESS);
  const hi = Math.max(inner, inner + side * WALL_THICKNESS);
  const outerLo = Math.min(side * HALF_X, lo);
  const outerHi = Math.max(side * HALF_X, hi);
  const y0 = BASE_HALF_WIDTH;
  wall(m, [lo, -y0, 0], [hi, -DOOR_HALF_WIDTH, WALL_HEIGHT]);
  wall(m, [lo, DOOR_HALF_WIDTH, 0], [hi, y0, WALL_HEIGHT]);
  wall(m, [lo, -DOOR_HALF_WIDTH, DOOR_HEIGHT], [hi, DOOR_HALF_WIDTH, WALL_HEIGHT]);
  wall(m, [outerLo, -y0 - WALL_THICKNESS, 0], [outerHi, -y0, WALL_HEIGHT]);
  wall(m, [outerLo, y0, 0], [outerHi, y0 + WALL_THICKNESS, WALL_HEIGHT]);
}

export function arenaGreybox(): Cmap {
  const m = new MapBuilder("arena_greybox");
  box(m, [-HALF_X, -HALF_Y, -16], [HALF_X, HALF_Y, 0]);
  const t = WALL_THICKNESS;
  wall(m, [-HALF_X - t, -HALF_Y - t, 0], [-HALF_X, HALF_Y + t, WALL_HEIGHT]);
  wall(m, [HALF_X, -HALF_Y - t, 0], [HALF_X + t, HALF_Y + t, WALL_HEIGHT]);
  wall(m, [-HALF_X, -HALF_Y - t, 0], [HALF_X, -HALF_Y, WALL_HEIGHT]);
  wall(m, [-HALF_X, HALF_Y, 0], [HALF_X, HALF_Y + t, WALL_HEIGHT]);

  // Bases: the inner wall's door anchors stand just inside and just outside it.
  base(m, -1);
  base(m, 1);
  const doorX = HALF_X - BASE_DEPTH;
  m.anchor("red_door_inside", stand(-doorX - 96, 0, 0), 0);
  m.anchor("red_door_outside", stand(-doorX + 64, 0, 0), 0);
  m.anchor("blue_door_inside", stand(doorX + 96, 0, 0), 180);
  m.anchor("blue_door_outside", stand(doorX - 64, 0, 0), 180);

  // Centre platform and its ramps.
  box(m, [-CENTER_HALF, -CENTER_HALF, 0], [CENTER_HALF, CENTER_HALF, CENTER_TOP]);
  m.ramp({ from: [0, CENTER_HALF + RAMP_RUN, 0], to: [0, CENTER_HALF, CENTER_TOP], width: 128 });
  m.ramp({ from: [0, -CENTER_HALF - RAMP_RUN, 0], to: [0, -CENTER_HALF, CENTER_TOP], width: 128 });
  m.anchor("center_top", stand(0, 0, CENTER_TOP), 0);
  m.anchor("ramp_north_base", stand(0, CENTER_HALF + RAMP_RUN + 24, 0), -90);
  m.anchor("ramp_south_base", stand(0, -CENTER_HALF - RAMP_RUN - 24, 0), 90);

  // Covered corridor along x, north of the centre.
  const cx = CORRIDOR_HALF_LENGTH;
  wall(m, [-cx, CORRIDOR_Y0 - 16, 0], [cx, CORRIDOR_Y0, CORRIDOR_HEIGHT]);
  wall(m, [-cx, CORRIDOR_Y1, 0], [cx, CORRIDOR_Y1 + 16, CORRIDOR_HEIGHT]);
  wall(m, [-cx, CORRIDOR_Y0 - 16, CORRIDOR_HEIGHT], [cx, CORRIDOR_Y1 + 16, CORRIDOR_HEIGHT + 16]);
  const corridorY = (CORRIDOR_Y0 + CORRIDOR_Y1) / 2;
  m.anchor("corridor_west", stand(-cx + 64, corridorY, 0), 0);
  m.anchor("corridor_east", stand(cx - 64, corridorY, 0), 180);

  // South ledge against the south wall, stairs climbing to it from the east.
  box(m, [-384, -HALF_Y, 0], [384, -896, LEDGE_TOP]);
  m.stairs({
    origin: [576, -960, 0],
    steps: 6,
    stepHeight: 16,
    stepDepth: 32,
    width: 128,
    direction: "-x",
  });
  m.anchor("ledge_south_top", stand(0, -960, LEDGE_TOP), 90);

  // Cover: crates beside the centre, low walls before the bases, wide crates near the ledge.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      box(m, [sx * 512 - 32, sy * 384 - 32, 0], [sx * 512 + 32, sy * 384 + 32, 64]);
    }
    wall(m, [sx * 768 - 8, -128, 0], [sx * 768 + 8, 128, 48]);
    box(m, [sx * 384 - 48, -752, 0], [sx * 384 + 48, -656, 48]);
  }

  for (let i = 0; i < FFA_SPAWNS.length; i++) {
    const [x, y, yaw] = FFA_SPAWNS[i] as (typeof FFA_SPAWNS)[number];
    m.spawn("info_player_start", stand(x, y, 0), yaw);
  }
  for (let i = 0; i < TEAM_SPAWN_X.length; i++) {
    for (let j = 0; j < TEAM_SPAWN_Y.length; j++) {
      const x = TEAM_SPAWN_X[i] as number;
      const y = TEAM_SPAWN_Y[j] as number;
      m.spawn("info_spawn_red", stand(x, y, 0), 0);
      m.spawn("info_spawn_blue", stand(-x, y, 0), 180);
    }
  }

  return m.compile();
}
