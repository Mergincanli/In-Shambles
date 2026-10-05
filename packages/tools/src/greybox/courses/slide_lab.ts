import type { Cmap } from "@game/shared";
import { MapBuilder } from "../MapBuilder";
import { floorTiles, stand } from "./common";

/**
 * slide_lab (docs/07 §3): power-slide fixtures. A long lane with distance-marker tiles fed by a
 * ramp, door frames, and slide-under gaps. A crouched player rests at floor + 1/32 (D-017), so
 * the hull top is at 40 + 1/32 u: the 41, 42 and 44 u gaps pass and the 40 u gap, anchored as
 * `slide_gap_40_blocked_*`, blocks (docs/07 §6).
 */

/** Marker tile length; the lane runs 4096 u past the ramp, long enough for any slide. */
const TILE = 128;
const LANE_X0 = -768;
/** The stairs up to the ramp platform start 128 u in from the floor's west edge. */
const STAIRS_X = -640;
const LANE_X1 = 4096;
const LANE_HALF_WIDTH = 256;

/** The platform and ramp the slide lane starts from: 64 u up over a 256 u run. */
const RAMP_TOP = 64;

/** docs/07 §6 doors: 48 u wide, 96 u tall. */
const DOOR_WIDTH = 48;
const DOOR_HEIGHT = 96;
const DOOR_LANE_Y = 768;

/** Slide-under gap heights, with the one that must block last. */
const SLIDE_GAPS = [
  ["slide_gap_41", 41],
  ["slide_gap_42", 42],
  ["slide_gap_44", 44],
  ["slide_gap_40_blocked", 40],
] as const;
const GAP_LANE_Y0 = 1152;
const GAP_LANE_PITCH = 256;
const GAP_LANE_HALF_WIDTH = 96;
/** The bar a slide passes under: 64 u deep along the lane. */
const BAR_X0 = 512;
const BAR_X1 = 576;
/** Height of the bar's top, the lane walls and the door frames. */
const FIXTURE_HEIGHT = 128;

export function slideLab(): Cmap {
  const m = new MapBuilder("slide_lab");
  floorTiles(m, {
    min: [LANE_X0, -LANE_HALF_WIDTH],
    max: [LANE_X1, LANE_HALF_WIDTH],
    axis: 0,
    tile: TILE,
    top: 0,
    bottom: -16,
  });
  m.box({ min: [LANE_X0, LANE_HALF_WIDTH, -16], max: [LANE_X1, 2048, 0] });

  // Stairs up to a platform, and the ramp from it down onto the lane.
  m.stairs({
    origin: [STAIRS_X, 0, 0],
    steps: 4,
    stepHeight: 16,
    stepDepth: 32,
    width: 256,
    direction: "+x",
  });
  m.box({ min: [-512, -128, 0], max: [-256, 128, RAMP_TOP] });
  m.ramp({ from: [-256, 0, RAMP_TOP], to: [0, 0, 0], width: 256 });
  m.spawn("info_player_start", stand(-448, 0, RAMP_TOP), 0);
  m.anchor("stairs_base", stand(STAIRS_X - 64, 0, 0), 0);
  m.anchor("ramp_top", stand(-384, 0, RAMP_TOP), 0);
  m.anchor("lane_start", stand(32, 0, 0), 0);
  m.anchor("lane_end", stand(LANE_X1 - 32, 0, 0), 0);

  // Two door frames 16 u thick, 512 u apart.
  const doorLo = DOOR_LANE_Y - DOOR_WIDTH / 2;
  const doorHi = DOOR_LANE_Y + DOOR_WIDTH / 2;
  for (const x of [512, 1024]) {
    m.wall({ min: [x, DOOR_LANE_Y - 128, 0], max: [x + 16, doorLo, FIXTURE_HEIGHT] });
    m.wall({ min: [x, doorHi, 0], max: [x + 16, DOOR_LANE_Y + 128, FIXTURE_HEIGHT] });
    m.wall({ min: [x, doorLo, DOOR_HEIGHT], max: [x + 16, doorHi, FIXTURE_HEIGHT] });
  }
  m.anchor("door_entry", stand(448, DOOR_LANE_Y, 0), 0);
  m.anchor("door_exit", stand(1104, DOOR_LANE_Y, 0), 0);

  // Slide-under gaps: a bar across a walled lane, `height` above the floor.
  for (let i = 0; i < SLIDE_GAPS.length; i++) {
    const [name, height] = SLIDE_GAPS[i] as (typeof SLIDE_GAPS)[number];
    const y = GAP_LANE_Y0 + i * GAP_LANE_PITCH;
    const lo = y - GAP_LANE_HALF_WIDTH;
    const hi = y + GAP_LANE_HALF_WIDTH;
    m.wall({ min: [384, lo - 16, 0], max: [704, lo, FIXTURE_HEIGHT] });
    m.wall({ min: [384, hi, 0], max: [704, hi + 16, FIXTURE_HEIGHT] });
    m.wall({ min: [BAR_X0, lo, height], max: [BAR_X1, hi, FIXTURE_HEIGHT] });
    m.anchor(`${name}_entry`, stand(BAR_X0 - 64, y, 0), 0);
    m.anchor(`${name}_exit`, stand(BAR_X1 + 64, y, 0), 0);
  }

  return m.compile();
}
