import type { Cmap } from "@game/shared";
import { MapBuilder } from "../MapBuilder";
import { stand } from "./common";

/**
 * jump_lab (docs/07 §3): jump distance and height fixtures. A raised take-off deck with one lane
 * per gap width, a row of ledges, a wall-jump chimney, single-wall kick lanes at four angles and
 * a curb that is too low to kick off (docs/07 §6: wall-jump walls are at least 64 u tall).
 */

/** docs/07 §3: gaps 64…320 u in steps of 32, ledges 24…120 u in steps of 8. */
const GAPS = [64, 96, 128, 160, 192, 224, 256, 288, 320] as const;
const LEDGES = [24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104, 112, 120] as const;

/** Deck and landing height: a missed jump drops back to the floor, clear of the lane. */
const DECK_TOP = 64;
const DECK_X1 = 512;
const LANE_PITCH = 192;
const LANDING_WIDTH = 128;
const LANDING_DEPTH = 256;

/** docs/07 §3: chimney walls 64 u apart and 512 u tall. */
const CHIMNEY_GAP = 64;
const CHIMNEY_HEIGHT = 512;

/**
 * Kick lanes, rotated about +Z by closed-form cos/sin (D-016: no Math.cos in the compiler).
 * sin 15° = (√6 − √2)/4, cos 15° = (√6 + √2)/4.
 */
const SQRT2 = Math.sqrt(2);
const SQRT3 = Math.sqrt(3);
const SQRT6 = Math.sqrt(6);
const KICK_LANES = [
  [15, (SQRT6 + SQRT2) / 4, (SQRT6 - SQRT2) / 4],
  [30, SQRT3 / 2, 1 / 2],
  [45, SQRT2 / 2, SQRT2 / 2],
  [60, 1 / 2, SQRT3 / 2],
] as const;
/** A 512 × 16 × 256 u wall: bottom sunk 16 u into the floor, 240 u standing. */
const KICK_HALF: readonly [number, number, number] = [256, 8, 128];
const KICK_CENTER_Z = 128 - 16;
/** The take-off anchor stands this far out along the wall's normal from its centre. */
const KICK_STANDOFF = 64;
/** docs/07 §3: a 24 u curb, well under the 64 u wall-jump minimum. */
const CURB_HEIGHT = 24;

export function jumpLab(): Cmap {
  const m = new MapBuilder("jump_lab");
  m.box({ min: [-1024, -2048, -16], max: [3072, 2048, 0] });
  m.spawn("info_player_start", stand(-512, 0, 0), 0);

  // Take-off deck with stairs up its west side, then a landing platform per lane.
  const laneY0 = (-(GAPS.length - 1) * LANE_PITCH) / 2;
  const deckHalf = (GAPS.length * LANE_PITCH) / 2;
  m.box({ min: [0, -deckHalf, 0], max: [DECK_X1, deckHalf, DECK_TOP] });
  m.stairs({
    origin: [-128, 0, 0],
    steps: 4,
    stepHeight: 16,
    stepDepth: 32,
    width: 256,
    direction: "+x",
  });
  for (let i = 0; i < GAPS.length; i++) {
    const gap = GAPS[i] as number;
    const y = laneY0 + i * LANE_PITCH;
    const x0 = DECK_X1 + gap;
    m.box({
      min: [x0, y - LANDING_WIDTH / 2, 0],
      max: [x0 + LANDING_DEPTH, y + LANDING_WIDTH / 2, DECK_TOP],
    });
    m.anchor(`gap_${gap}_takeoff`, stand(DECK_X1 - 16, y, DECK_TOP), 0);
    m.anchor(`gap_${gap}_landing`, stand(x0 + 16, y, DECK_TOP), 0);
  }

  // Ledges, 128 × 128 u, approached from the south.
  for (let i = 0; i < LEDGES.length; i++) {
    const h = LEDGES[i] as number;
    const x = -832 + 192 * i;
    m.box({ min: [x - 64, -1536, 0], max: [x + 64, -1408, h] });
    m.anchor(`ledge_${h}_base`, stand(x, -1568, 0), 90);
    m.anchor(`ledge_${h}_top`, stand(x, -1472, h), 90);
  }

  // Chimney: a 32 u wall and a 128 u block to land on, 64 u apart, open at both ends.
  const chimneyY0 = 1184;
  m.wall({ min: [-768, chimneyY0 - 32, 0], max: [-512, chimneyY0, CHIMNEY_HEIGHT] });
  m.wall({
    min: [-768, chimneyY0 + CHIMNEY_GAP, 0],
    max: [-512, chimneyY0 + CHIMNEY_GAP + 128, CHIMNEY_HEIGHT],
  });
  m.anchor("chimney_base", stand(-640, chimneyY0 + CHIMNEY_GAP / 2, 0), 90);
  m.anchor("chimney_top", stand(-640, chimneyY0 + CHIMNEY_GAP + 64, CHIMNEY_HEIGHT), 90);

  // Kick lanes, each standing alone, with a take-off spot on the side its normal (−sin, cos)
  // faces; the anchor is rounded to whole units, so it stays on the origin grid.
  for (let i = 0; i < KICK_LANES.length; i++) {
    const [degrees, cos, sin] = KICK_LANES[i] as (typeof KICK_LANES)[number];
    const cx = 640 * i;
    const cy = 1536;
    m.rotatedBox({ center: [cx, cy, KICK_CENTER_Z], halfExtents: KICK_HALF, cos, sin });
    const ax = cx + Math.round(-sin * KICK_STANDOFF);
    const ay = cy + Math.round(cos * KICK_STANDOFF);
    m.anchor(`kick_${degrees}_takeoff`, stand(ax, ay, 0), degrees - 90);
  }

  // The curb, next to the kick lanes.
  m.box({ min: [2432, 1504, 0], max: [2688, 1568, CURB_HEIGHT] });
  m.anchor("curb_base", stand(2560, 1472, 0), 90);
  m.anchor("curb_top", stand(2560, 1536, CURB_HEIGHT), 90);

  return m.compile();
}
