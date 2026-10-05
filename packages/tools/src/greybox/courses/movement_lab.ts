import type { Cmap } from "@game/shared";
import { MapBuilder } from "../MapBuilder";
import { floorAround, floorTiles, pool, stand } from "./common";

/**
 * movement_lab (docs/07 §3): ground movement fixtures. An open 6144 × 6144 u floor for strafe and
 * circle jumps (twelve circle-jump hops cover about 4000 u, M1 design I) holding the runway, and
 * north of it a feature zone: single steps, stairs, the slope set, a ladder, a water pool and a
 * crouch tunnel. Every feature has named anchors where a standing player fits with feet on the
 * ground (common.ts `stand`).
 */

/** Half the open floor's side. */
const OPEN_HALF = 3072;
/** Distance-marker tile width; also the coplanar-seam spacing. */
const TILE = 128;
const FLOOR_THICKNESS = 16;
/** The timed runway: 2048 u between the timer triggers' matching faces, each trigger 16 u deep. */
const RUNWAY_HALF = 1024;
const TIMER_DEPTH = 16;

/** The feature zone north of the open floor; its slab is thick enough to dig the pool into. */
const ZONE_Y0 = OPEN_HALF;
const ZONE_Y1 = 5120;
const ZONE_BOTTOM = -160;
/** The y where the step, stair and slope fixtures start; their base anchors stand south of it. */
const FEATURE_Y = 3584;
/** Base anchors stand this far in front of a fixture: the hull's face is 17 u from it. */
const BASE_GAP = 32;

/** docs/07 §3: 16 climbs, 18 is the step height limit, 19 needs a jump (docs/07 §6). */
const STEP_HEIGHTS = [16, 18, 19] as const;
/** docs/07 §3 slope set: either side of the 0.7 walkable limit (docs/03), and 0.8 (3-4-5). */
const SLOPE_NORMALS = [
  ["069", 0.69],
  ["071", 0.71],
  ["080", 0.8],
] as const;

/**
 * Pool sections, by water level when standing on the bottom: feet (1), waist (2) and eyes (3)
 * under water. Eyes are 50 u above the feet standing (docs/03 §2), so 36 u reaches the waist
 * without the eyes and 128 u covers them; 128 u is also the fall tower's landing depth.
 */
const POOL_SECTIONS = [
  ["water_wade", 12],
  ["water_waist", 36],
  ["water_deep", 128],
] as const;
const POOL_X0 = 1792;
const POOL_SECTION_LENGTH = 384;
const POOL_Y0 = 3584;
const POOL_Y1 = 4096;

/** Crouch tunnel clearance: crouched (40 u, at rest 40 + 1/32) fits, standing (56 u) does not. */
const TUNNEL_CLEARANCE = 48;

export function movementLab(): Cmap {
  const m = new MapBuilder("movement_lab");

  // The open floor: strips across x in the south half (the runway's distance markers) and across
  // y in the north half, so seams run both ways and meet in T-junctions at y = 0.
  floorTiles(m, {
    min: [-OPEN_HALF, -OPEN_HALF],
    max: [OPEN_HALF, 0],
    axis: 0,
    tile: TILE,
    top: 0,
    bottom: -FLOOR_THICKNESS,
  });
  floorTiles(m, {
    min: [-OPEN_HALF, 0],
    max: [OPEN_HALF, OPEN_HALF],
    axis: 1,
    tile: TILE,
    top: 0,
    bottom: -FLOOR_THICKNESS,
  });
  const poolX1 = POOL_X0 + POOL_SECTIONS.length * POOL_SECTION_LENGTH;
  floorAround(
    m,
    [-OPEN_HALF, ZONE_Y0],
    [OPEN_HALF, ZONE_Y1],
    [POOL_X0, POOL_Y0],
    [poolX1, POOL_Y1],
    0,
    ZONE_BOTTOM,
  );

  // Runway along +x, 256 u wide: the timer triggers' west faces are 2048 u apart and so are
  // their east faces, so start-on-enter/stop-on-enter and start-on-leave/stop-on-leave both time
  // 2048 u. The anchors stand just outside the triggers, so a run between them crosses both.
  const runwayY = -1536;
  m.spawn("info_player_start", stand(-1152, runwayY, 0), 0);
  m.anchor("runway_start", stand(-RUNWAY_HALF - 32, runwayY, 0), 0);
  m.anchor("runway_end", stand(RUNWAY_HALF + TIMER_DEPTH + 32, runwayY, 0), 0);
  m.timer("start", {
    min: [-RUNWAY_HALF, runwayY - 128, 0],
    max: [-RUNWAY_HALF + TIMER_DEPTH, runwayY + 128, 128],
  });
  m.timer("stop", {
    min: [RUNWAY_HALF, runwayY - 128, 0],
    max: [RUNWAY_HALF + TIMER_DEPTH, runwayY + 128, 128],
  });

  // Single steps, 256 × 256 u, climbed northwards.
  for (let i = 0; i < STEP_HEIGHTS.length; i++) {
    const h = STEP_HEIGHTS[i] as number;
    const x = -2880 + 320 * i;
    m.box({ min: [x - 128, FEATURE_Y, 0], max: [x + 128, FEATURE_Y + 256, h] });
    m.anchor(`step_${h}_base`, stand(x, FEATURE_Y - BASE_GAP, 0), 90);
    m.anchor(`step_${h}_top`, stand(x, FEATURE_Y + 128, h), 90);
  }

  // Stairs: 8 steps of 16 × 32 u up to a 128 u landing.
  const stairsX = -1536;
  const stairsTop = m.stairs({
    origin: [stairsX, FEATURE_Y, 0],
    steps: 8,
    stepHeight: 16,
    stepDepth: 32,
    width: 192,
    direction: "+y",
  });
  m.box({
    min: [stairsX - 96, FEATURE_Y + 256, 0],
    max: [stairsX + 96, FEATURE_Y + 448, stairsTop],
  });
  m.anchor("stairs_base", stand(stairsX, FEATURE_Y - BASE_GAP, 0), 90);
  m.anchor("stairs_top", stand(stairsX, FEATURE_Y + 352, stairsTop), 90);

  // Slope set: 256 u runs climbing north, each with a platform at its crest.
  for (let i = 0; i < SLOPE_NORMALS.length; i++) {
    const [tag, normalZ] = SLOPE_NORMALS[i] as (typeof SLOPE_NORMALS)[number];
    const x = -768 + 384 * i;
    const top = m.slope({
      from: [x, FEATURE_Y, 0],
      run: 256,
      normalZ,
      width: 192,
      direction: "+y",
    });
    m.box({ min: [x - 96, FEATURE_Y + 256, 0], max: [x + 96, FEATURE_Y + 448, top] });
    m.anchor(`slope_${tag}_base`, stand(x, FEATURE_Y - BASE_GAP, 0), 90);
    m.anchor(`slope_${tag}_top`, stand(x, FEATURE_Y + 352, top), 90);
  }

  // Ladder: the south face of a 384 u block; the base anchor's hull is 1 u from the wall, inside
  // the LADDER volume.
  const ladderX = 1408;
  const ladderY = 3712;
  m.ladder({
    wallMin: [ladderX - 128, ladderY, 0],
    wallMax: [ladderX + 128, 3840, 384],
    face: "-y",
  });
  m.anchor("ladder_base", stand(ladderX, ladderY - 16, 0), 90);
  m.anchor("ladder_top", stand(ladderX, 3776, 384), 90);

  // Pool: a pit in the zone slab, wading, waist-deep and deep sections from west to east.
  for (let i = 0; i < POOL_SECTIONS.length; i++) {
    const [name, depth] = POOL_SECTIONS[i] as (typeof POOL_SECTIONS)[number];
    const x0 = POOL_X0 + i * POOL_SECTION_LENGTH;
    const x1 = x0 + POOL_SECTION_LENGTH;
    pool(m, [x0, POOL_Y0], [x1, POOL_Y1], 0, ZONE_BOTTOM, depth);
    m.anchor(name, stand((x0 + x1) / 2, (POOL_Y0 + POOL_Y1) / 2, -depth), 0);
  }

  // Crouch tunnel: 256 u long along +x, 64 u wide inside, 16 u walls and roof.
  const tunnelX0 = -2560;
  const tunnelX1 = -2304;
  const tunnelY = 4480;
  m.wall({ min: [tunnelX0, tunnelY - 48, 0], max: [tunnelX1, tunnelY - 32, TUNNEL_CLEARANCE] });
  m.wall({ min: [tunnelX0, tunnelY + 32, 0], max: [tunnelX1, tunnelY + 48, TUNNEL_CLEARANCE] });
  m.wall({
    min: [tunnelX0, tunnelY - 48, TUNNEL_CLEARANCE],
    max: [tunnelX1, tunnelY + 48, TUNNEL_CLEARANCE + 16],
  });
  m.anchor("tunnel_entry", stand(tunnelX0 - BASE_GAP, tunnelY, 0), 0);
  m.anchor("tunnel_exit", stand(tunnelX1 + BASE_GAP, tunnelY, 0), 0);

  return m.compile();
}
