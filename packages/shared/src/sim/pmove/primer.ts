import { entityEventValue } from "../../net/worldFrame";
import { TICK_DT } from "../../time";
import { buildBrush } from "../../world/brushBuild";
import {
  type CollisionBrushSource,
  type CollisionWorld,
  createCollisionWorld,
} from "../../world/collisionWorld";
import { CONTENTS_SLICK, CONTENTS_SOLID, CONTENTS_WATER, SURF_LADDER } from "../../world/contents";
import { boxPlanes, rotatedBoxPlanes, type Triple, wedgePlanes } from "../../world/shapes";
import { TRACE_EPSILON } from "../../world/trace";
import { ENTITY_NONE } from "../entity";
import { PMEV_JUMP, PMEV_LAND, PMEV_STEP, PmoveEvent, PmoveEvents } from "../events";
import { HULL_MINS } from "../hull";
import {
  PlayerState,
  PMF_CROUCHED,
  PMF_GROUNDED,
  PMF_ON_LADDER,
  quantizePlayerState,
} from "../playerState";
import { BUTTON_CROUCH, BUTTON_JUMP, BUTTON_WALK, MOVE_AXIS_MAX, UserCmd } from "../usercmd";
import { PmoveTraceLog } from "./debug";
import type { PmoveParams } from "./params";
import { pmove } from "./pmove";

/**
 * The pmove primer (D-040, M3 design §2.11). A pmove branch first reached after V8 has optimized
 * its function deoptimizes it, and the tick then boxes doubles until V8 optimizes it again: the
 * first stairs (the slide move's second clip and crease) or the first ladder cost 1.7–5.4 MB once
 * per process (docs/10 §4.4). The primer runs every move mode and late branch on a small built-in
 * course at match and prediction start, on scratch state, so the deopts (and the first
 * optimizations) happen there instead of in the first minutes of play.
 *
 * It is inert: its own PlayerState, cmd, PmoveEvents and trace log; it reads the caller's params
 * and writes nothing the caller holds (no registry, PRNG, session or event counter; pmove's own
 * per-module scratch and its last-snap observer start again from PlayerState every tick).
 */

/**
 * Ticks the primer runs (design value, measured; not an estimate of the original game, and it
 * changes no result). Enough for the script to repeat under the three pairings of events and trace
 * log that play uses, so each branch is met both before V8 optimizes pmove and after, and for the
 * ladder and swim moves to get the thousands of calls V8 wants before it optimizes them. On the
 * 4-vCPU cloud VM under tsx: about 160–190 ms in a fresh process, 50–60 ms warm (a primer tick is
 * collision-heavy), twice that on a loaded host, against the design's 45 ms estimate (D-040).
 */
export const PMOVE_PRIMER_TICKS = 20_000;

const NORTH = 16384;
const SOUTH = 49152;
const EAST = 0;
const WEST = 32768;
const FWD = MOVE_AXIS_MAX;
const BACK = -MOVE_AXIS_MAX;
const RIGHT = MOVE_AXIS_MAX;
const LEFT = -MOVE_AXIS_MAX;
/** Pitch for diving (and, negated, surfacing): about 45° (u16 units; cmds carry it as a u16). */
const DIVE = 8192;

/** Course layout (u). The floor's top is z = 0; features start at FEATURE_Y and rise north. */
const FEATURE_Y = 128;
/** Segment starts stand this far south of a feature: the hull's face 17 u from it. */
const START_Y = FEATURE_Y - 32;
const X_STEP16 = -1408;
const X_STEP18 = -1216;
const X_STEP19 = -1024;
const X_STAIRS = -768;
const X_SLOPE071 = -512;
const X_SLOPE069 = -256;
const X_STEEP = 0;
const X_CREASE = 256;
const X_TUNNEL = 512;
const X_SLICK = 768;
const X_LADDER = 1024;
/** The pool: three 256 u sections along +x (wade 12, waist 36, deep 128 u), y in [0, 512]. */
const POOL_X0 = 1280;
const POOL_X1 = 2048;
const POOL_Y1 = 512;
const POOL_DEPTHS = [12, 36, 128] as const;
/** The walled area: the open strip south of y = 0 is for runs, circles and hops. */
const AREA_X0 = -1664;
const AREA_X1 = 2304;
const AREA_Y0 = -512;
const AREA_Y1 = 1024;
const FLOOR_BOTTOM = -192;
/** Stairs: 8 steps of 16 × 32 u up to a 128 u landing (as movement_lab's). */
const STAIRS_TOP = 128;
/** Slopes: 256 u runs; the heights give normal z 0.7099 (walkable) and 0.6907 (too steep). */
const SLOPE_RUN = 256;
const SLOPE071_H = 254;
const SLOPE069_H = 268;
/** Ladder wall: its south face (y = LADDER_Y) carries SURF_LADDER. */
const LADDER_Y = 256;
const LADDER_TOP = 256;
/** Crouch tunnel: 48 u clearance, so crouched (40 u) fits and standing (56 u) does not. */
const TUNNEL_CLEARANCE = 48;

function solid(planes: Float64Array, contents = CONTENTS_SOLID): CollisionBrushSource {
  const b = buildBrush(planes, "primer");
  return { planes: b.planes, faceCount: b.faceCount, bounds: b.bounds, contents };
}

/** A box whose −y face (boxPlanes' third plane) is a ladder. */
function ladderWall(min: Triple, max: Triple): CollisionBrushSource {
  const b = buildBrush(boxPlanes(min, max), "primer ladder");
  const flags = new Uint32Array(b.planes.length / 4);
  for (let f = 0; f < b.faceCount; f++) if (b.faceSource[f] === 2) flags[f] = SURF_LADDER;
  return {
    planes: b.planes,
    faceCount: b.faceCount,
    bounds: b.bounds,
    contents: CONTENTS_SOLID,
    surfaceFlags: flags,
  };
}

function box(min: Triple, max: Triple, contents = CONTENTS_SOLID): CollisionBrushSource {
  return solid(boxPlanes(min, max), contents);
}

let primerWorld: CollisionWorld | null = null;

/**
 * The primer's course (built once, then cached): a walled floor with an open strip; 16, 18 and
 * 19 u steps and a stairs flight; 0.71 and 0.69 slopes with platforms; a steep wedge; a crease
 * of two rotated walls; a crouch tunnel; a slick strip; a ladder face; a pool with wading,
 * waist-deep and deep sections.
 */
export function buildPrimerWorld(): CollisionWorld {
  if (primerWorld !== null) return primerWorld;
  const b: CollisionBrushSource[] = [];
  // Floor around the pool, and the pool's three section floors and water volumes.
  b.push(box([AREA_X0, AREA_Y0, FLOOR_BOTTOM], [AREA_X1, 0, 0]));
  b.push(box([AREA_X0, POOL_Y1, FLOOR_BOTTOM], [AREA_X1, AREA_Y1, 0]));
  b.push(box([AREA_X0, 0, FLOOR_BOTTOM], [POOL_X0, POOL_Y1, 0]));
  b.push(box([POOL_X1, 0, FLOOR_BOTTOM], [AREA_X1, POOL_Y1, 0]));
  for (let i = 0; i < POOL_DEPTHS.length; i++) {
    const depth = POOL_DEPTHS[i] as number;
    const x0 = POOL_X0 + 256 * i;
    b.push(box([x0, 0, FLOOR_BOTTOM], [x0 + 256, POOL_Y1, -depth]));
    b.push(box([x0, 0, -depth], [x0 + 256, POOL_Y1, 0], CONTENTS_WATER));
  }
  // Perimeter walls.
  b.push(box([AREA_X0 - 16, AREA_Y0 - 16, 0], [AREA_X1 + 16, AREA_Y0, 512]));
  b.push(box([AREA_X0 - 16, AREA_Y1, 0], [AREA_X1 + 16, AREA_Y1 + 16, 512]));
  b.push(box([AREA_X0 - 16, AREA_Y0, 0], [AREA_X0, AREA_Y1, 512]));
  b.push(box([AREA_X1, AREA_Y0, 0], [AREA_X1 + 16, AREA_Y1, 512]));
  // Single steps.
  b.push(box([X_STEP16 - 64, FEATURE_Y, 0], [X_STEP16 + 64, FEATURE_Y + 128, 16]));
  b.push(box([X_STEP18 - 64, FEATURE_Y, 0], [X_STEP18 + 64, FEATURE_Y + 128, 18]));
  b.push(box([X_STEP19 - 64, FEATURE_Y, 0], [X_STEP19 + 64, FEATURE_Y + 128, 19]));
  // Stairs: each step's box runs on to the landing's north edge.
  for (let k = 0; k < 8; k++) {
    b.push(
      box([X_STAIRS - 96, FEATURE_Y + 32 * k, 0], [X_STAIRS + 96, FEATURE_Y + 416, 16 * (k + 1)]),
    );
  }
  // Slopes climbing north, each with a platform at its crest.
  const s071: Triple = [X_SLOPE071 - 96, FEATURE_Y, 0];
  b.push(solid(wedgePlanes(s071, [X_SLOPE071 + 96, FEATURE_Y + SLOPE_RUN, SLOPE071_H], "+y")));
  b.push(
    box(
      [X_SLOPE071 - 96, FEATURE_Y + SLOPE_RUN, 0],
      [X_SLOPE071 + 96, FEATURE_Y + 384, SLOPE071_H],
    ),
  );
  const s069: Triple = [X_SLOPE069 - 96, FEATURE_Y, 0];
  b.push(solid(wedgePlanes(s069, [X_SLOPE069 + 96, FEATURE_Y + SLOPE_RUN, SLOPE069_H], "+y")));
  b.push(
    box(
      [X_SLOPE069 - 96, FEATURE_Y + SLOPE_RUN, 0],
      [X_SLOPE069 + 96, FEATURE_Y + 384, SLOPE069_H],
    ),
  );
  // A steep wedge (normal z about 0.32): it can only be slid down.
  b.push(
    solid(wedgePlanes([X_STEEP - 96, FEATURE_Y, 0], [X_STEEP + 96, FEATURE_Y + 64, 192], "+y")),
  );
  // Two walls rotated ±53° about +z meeting in a V that points north: a walk north runs into
  // the crease and the corner.
  b.push(solid(rotatedBoxPlanes([X_CREASE - 60, FEATURE_Y + 80, 64], [110, 8, 64], 0.6, 0.8)));
  b.push(solid(rotatedBoxPlanes([X_CREASE + 60, FEATURE_Y + 80, 64], [110, 8, 64], -0.6, 0.8)));
  // Crouch tunnel along +y: two walls and a roof.
  const ty0 = FEATURE_Y;
  const ty1 = FEATURE_Y + 256;
  b.push(box([X_TUNNEL - 48, ty0, 0], [X_TUNNEL - 32, ty1, TUNNEL_CLEARANCE]));
  b.push(box([X_TUNNEL + 32, ty0, 0], [X_TUNNEL + 48, ty1, TUNNEL_CLEARANCE]));
  b.push(box([X_TUNNEL - 48, ty0, TUNNEL_CLEARANCE], [X_TUNNEL + 48, ty1, TUNNEL_CLEARANCE + 16]));
  // A slick strip, 8 u up (a step onto it).
  b.push(
    box(
      [X_SLICK - 96, FEATURE_Y, 0],
      [X_SLICK + 96, FEATURE_Y + 512, 8],
      CONTENTS_SOLID | CONTENTS_SLICK,
    ),
  );
  // The ladder: the south face of a 256 u block.
  b.push(ladderWall([X_LADDER - 128, LADDER_Y, 0], [X_LADDER + 128, LADDER_Y + 128, LADDER_TOP]));
  primerWorld = createCollisionWorld(b);
  return primerWorld;
}

/**
 * One scripted stretch: optionally a fresh start at `at` (feet position; airborne until the first
 * ground trace, at rest or moving at `vel`), then `ticks` ticks of one cmd, the yaw turning by `yawStep` a tick and
 * jump pressed on every `jumpEvery`-th tick (0: never; with BUTTON_JUMP held, always).
 */
export interface PrimerSegment {
  readonly at: Triple | null;
  /** The velocity a fresh start begins with (u/s); at rest when null. */
  readonly vel: Triple | null;
  readonly ticks: number;
  readonly yaw: number;
  readonly yawStep: number;
  readonly pitch: number;
  readonly forward: number;
  readonly right: number;
  readonly up: number;
  readonly buttons: number;
  readonly jumpEvery: number;
}

interface SegmentInit {
  at?: Triple;
  vel?: Triple;
  ticks: number;
  yaw: number;
  yawStep?: number;
  pitch?: number;
  forward?: number;
  right?: number;
  up?: number;
  buttons?: number;
  jumpEvery?: number;
}

function seg(s: SegmentInit): PrimerSegment {
  return {
    at: s.at ?? null,
    vel: s.vel ?? null,
    ticks: s.ticks,
    yaw: s.yaw,
    yawStep: s.yawStep ?? 0,
    pitch: s.pitch ?? 0,
    forward: s.forward ?? 0,
    right: s.right ?? 0,
    up: s.up ?? 0,
    buttons: s.buttons ?? 0,
    jumpEvery: s.jumpEvery ?? 0,
  };
}

/** Once, at the segment's first tick. */
const ONCE = 1 << 20;

/**
 * A long stretch on the ladder's face, never touching the ground or the top: V8 optimizes a move
 * function only after some thousands of calls, so each mode needs its share of the ticks (the
 * ladder and the swim would otherwise stay in the slower tiers, boxing, until play reached them).
 */
function ladderDrill(): PrimerSegment[] {
  const out = [seg({ at: [X_LADDER, LADDER_Y - 16, 60], ticks: 10, yaw: NORTH })];
  for (let i = 0; i < 12; i++) {
    out.push(seg({ ticks: 30, yaw: NORTH, forward: FWD }));
    out.push(seg({ ticks: 15, yaw: NORTH + 1024 * (i & 1), pitch: DIVE * ((i & 2) - 1) }));
    out.push(seg({ ticks: 30, yaw: NORTH, forward: BACK }));
    out.push(seg({ ticks: 10, yaw: NORTH, right: RIGHT }));
    out.push(seg({ ticks: 10, yaw: NORTH, right: LEFT }));
  }
  return out;
}

/** A long swim in the deep section: circles, rises, dives, sinks, strafes and back-pedals. */
function swimDrill(): PrimerSegment[] {
  const out = [seg({ at: [POOL_X1 - 128, 256, -100], ticks: 10, yaw: NORTH })];
  for (let i = 0; i < 8; i++) {
    const turn = 300 * ((i & 1) * 2 - 1);
    out.push(seg({ ticks: 40, yaw: NORTH, yawStep: turn, forward: FWD }));
    out.push(seg({ ticks: 20, yaw: EAST, buttons: BUTTON_JUMP }));
    out.push(seg({ ticks: 20, yaw: SOUTH, pitch: DIVE, forward: FWD }));
    out.push(seg({ ticks: 30, yaw: SOUTH }));
    out.push(seg({ ticks: 20, yaw: WEST, buttons: BUTTON_CROUCH, right: RIGHT }));
    out.push(seg({ ticks: 20, yaw: NORTH, yawStep: -turn, right: RIGHT, up: MOVE_AXIS_MAX }));
    out.push(seg({ ticks: 20, yaw: NORTH, pitch: -DIVE, forward: BACK }));
  }
  return out;
}

/**
 * The primer's script (D-040): every move mode and late branch of docs/03 §3–§4 on the primer's
 * course. Walk, run, back-pedal, crouch and walk caps; circles and strafe hops with landings;
 * step-up (16, 18) and the 19 u step's jump; stairs up, down, jumped and walked off (the slide
 * move's second clip, the crease, step-down and the landing below); the walkable slope up and
 * down, the steep one and the wedge slid down; the rotated-wall crease and corner stop; the crouch
 * tunnel (blocked stand and jump); the slick strip; ladder climbs over the top, jump-offs,
 * descents, strafes and a turn away; the pool's wading, waist and deep water: swim, rise, dive,
 * sink, surface, the wall and the climb out. Then the ladder and swim drills.
 */
export const PRIMER_SCRIPT: readonly PrimerSegment[] = [
  // Open strip: run, circle with jumps, strafe hops, back-pedal, walk, crouch, crouch-jumps.
  seg({ at: [AREA_X0 + 128, -256, 0], ticks: 60, yaw: EAST, forward: FWD }),
  seg({ ticks: 240, yaw: EAST, yawStep: 300, forward: FWD, right: RIGHT, jumpEvery: 50 }),
  seg({
    at: [AREA_X0 + 128, -256, 0],
    ticks: 180,
    yaw: 8192,
    forward: FWD,
    right: RIGHT,
    jumpEvery: 2,
  }),
  seg({ ticks: 60, yaw: WEST, forward: BACK, right: RIGHT }),
  seg({ ticks: 45, yaw: WEST, forward: FWD, buttons: BUTTON_WALK }),
  seg({ ticks: 45, yaw: WEST, forward: FWD, buttons: BUTTON_CROUCH }),
  seg({ ticks: 60, yaw: WEST, forward: FWD, buttons: BUTTON_CROUCH, jumpEvery: 30 }),
  seg({ ticks: 40, yaw: WEST }),
  // Jump held down through the landings: no new jump until it is released.
  seg({ ticks: 90, yaw: EAST, forward: FWD, buttons: BUTTON_JUMP }),
  // A long fall onto the open floor.
  seg({ at: [0, -256, 320], ticks: 90, yaw: EAST, forward: FWD }),
  // Steps: 16 and 18 climb, 19 needs a jump; off the far side.
  seg({ at: [X_STEP16, START_Y, 0], ticks: 75, yaw: NORTH, forward: FWD }),
  seg({ at: [X_STEP18, START_Y, 0], ticks: 75, yaw: NORTH, forward: FWD }),
  seg({ at: [X_STEP19, START_Y, 0], ticks: 30, yaw: NORTH, forward: FWD }),
  seg({ ticks: 60, yaw: NORTH, forward: FWD, jumpEvery: 40 }),
  // Stairs: up, across the landing and off its north edge, back into its north face; down;
  // jumped up; climbed crouched.
  seg({ at: [X_STAIRS, START_Y, 0], ticks: 120, yaw: NORTH, forward: FWD }),
  seg({ ticks: 45, yaw: SOUTH, forward: FWD, right: RIGHT }),
  seg({ at: [X_STAIRS, FEATURE_Y + 384, STAIRS_TOP], ticks: 90, yaw: SOUTH, forward: FWD }),
  seg({ at: [X_STAIRS + 32, START_Y, 0], ticks: 75, yaw: NORTH, forward: FWD, jumpEvery: 25 }),
  seg({
    at: [X_STAIRS - 32, START_Y, 0],
    ticks: 120,
    yaw: NORTH,
    forward: FWD,
    buttons: BUTTON_CROUCH,
  }),
  // The walkable slope up and over its platform, then down; strafing across it.
  seg({ at: [X_SLOPE071, START_Y, 0], ticks: 150, yaw: NORTH, forward: FWD }),
  seg({ at: [X_SLOPE071, FEATURE_Y + 320, SLOPE071_H], ticks: 90, yaw: SOUTH, forward: FWD }),
  seg({
    at: [X_SLOPE071 - 64, FEATURE_Y + 64, 80],
    ticks: 60,
    yaw: EAST,
    forward: FWD,
    right: LEFT,
  }),
  // The steep slope: walked into, jumped onto, slid down from its platform.
  seg({ at: [X_SLOPE069, START_Y, 0], ticks: 60, yaw: NORTH, forward: FWD }),
  seg({ ticks: 60, yaw: NORTH, forward: FWD, jumpEvery: 20 }),
  seg({ at: [X_SLOPE069, FEATURE_Y + 320, SLOPE069_H], ticks: 120, yaw: SOUTH, forward: FWD }),
  // The steep wedge: jumped onto and slid off.
  seg({ at: [X_STEEP, START_Y, 0], ticks: 90, yaw: NORTH, forward: FWD, jumpEvery: 15 }),
  seg({ at: [X_STEEP + 32, FEATURE_Y + 16, 160], ticks: 60, yaw: NORTH }),
  // The crease: walked and jumped into the V, strafing along one wall, then off it.
  seg({ at: [X_CREASE, START_Y, 0], ticks: 60, yaw: NORTH, forward: FWD }),
  seg({ ticks: 30, yaw: NORTH, forward: FWD, right: RIGHT }),
  seg({ ticks: 45, yaw: NORTH, forward: FWD, jumpEvery: 15 }),
  seg({ ticks: 30, yaw: NORTH + 2048, yawStep: 64, forward: FWD, right: LEFT }),
  seg({ ticks: 30, yaw: SOUTH, forward: FWD }),
  // The tunnel: standing into its roof; crouched in; crouch released under the roof; a blocked
  // jump; out the far end, standing up.
  seg({ at: [X_TUNNEL, START_Y, 0], ticks: 30, yaw: NORTH, forward: FWD }),
  seg({ ticks: 30, yaw: NORTH, forward: FWD, buttons: BUTTON_CROUCH }),
  seg({ ticks: 30, yaw: NORTH, forward: FWD }),
  seg({ ticks: 30, yaw: NORTH, forward: FWD, jumpEvery: 10 }),
  seg({ ticks: 150, yaw: NORTH, forward: FWD }),
  // The slick strip: run on, let go and slide, crouch, jump.
  seg({ at: [X_SLICK, START_Y, 0], ticks: 60, yaw: NORTH, forward: FWD }),
  seg({ ticks: 45, yaw: NORTH }),
  seg({ ticks: 30, yaw: NORTH + 4096, forward: FWD, buttons: BUTTON_CROUCH }),
  seg({ ticks: 30, yaw: NORTH, forward: FWD, jumpEvery: 20 }),
  // The ladder: climbed over the top; climbed and jumped off; hung on, descended, strafed along
  // and climbed looking down; turned away from.
  seg({ at: [X_LADDER, LADDER_Y - 16, 0], ticks: 200, yaw: NORTH, forward: FWD }),
  seg({ ticks: 30, yaw: NORTH, forward: FWD, jumpEvery: 10 }),
  seg({ at: [X_LADDER - 64, LADDER_Y - 16, 0], ticks: 60, yaw: NORTH, forward: FWD }),
  seg({ ticks: 75, yaw: NORTH, forward: FWD, jumpEvery: ONCE }),
  seg({ at: [X_LADDER + 32, LADDER_Y - 16, 120], ticks: 20, yaw: NORTH }),
  seg({ ticks: 30, yaw: NORTH, pitch: DIVE, forward: FWD }),
  seg({ ticks: 15, yaw: NORTH, right: RIGHT }),
  seg({ ticks: 15, yaw: NORTH, right: LEFT }),
  seg({ ticks: 120, yaw: NORTH, forward: BACK }),
  seg({
    at: [X_LADDER - 96, LADDER_Y - 16, 0],
    ticks: 60,
    yaw: NORTH,
    forward: FWD,
    buttons: BUTTON_JUMP,
  }),
  seg({ at: [X_LADDER, LADDER_Y - 16, 60], ticks: 10, yaw: NORTH, forward: FWD }),
  seg({ ticks: 40, yaw: SOUTH, forward: FWD }),
  // The pool: walked in from the west (wade, waist, then into the deep), swum east to the wall,
  // up, down, sunk, dived and surfaced, crouched at waist depth, then back west and out.
  seg({ at: [POOL_X0 - 64, 256, 0], ticks: 180, yaw: EAST, forward: FWD }),
  seg({ ticks: 90, yaw: EAST, forward: FWD, right: RIGHT }),
  seg({ ticks: 45, yaw: EAST, buttons: BUTTON_JUMP }),
  seg({ ticks: 45, yaw: EAST, buttons: BUTTON_CROUCH }),
  seg({ ticks: 90, yaw: EAST }),
  seg({ ticks: 45, yaw: WEST, pitch: DIVE, forward: FWD }),
  seg({ ticks: 60, yaw: WEST, pitch: -DIVE, forward: FWD, up: MOVE_AXIS_MAX }),
  seg({ ticks: 240, yaw: WEST, forward: FWD, jumpEvery: 30 }),
  // Down into the pool's edges and corners: the waist floor against the wading section's riser,
  // a corner of two walls, the deep floor's corner (the slide move's stop on a velocity turned
  // back against itself).
  seg({
    at: [POOL_X0 + 320, 256, -36],
    ticks: 40,
    yaw: WEST,
    pitch: DIVE,
    forward: FWD,
    buttons: BUTTON_CROUCH,
  }),
  seg({
    at: [POOL_X0 + 320, 40, -36],
    ticks: 40,
    yaw: 40960,
    pitch: DIVE,
    forward: FWD,
    buttons: BUTTON_CROUCH,
  }),
  seg({
    at: [POOL_X1 - 128, 40, -110],
    ticks: 40,
    yaw: 40960,
    pitch: DIVE,
    forward: FWD,
    buttons: BUTTON_CROUCH,
  }),
  seg({ ticks: 40, yaw: 57344, pitch: DIVE, forward: FWD, right: RIGHT }),
  seg({
    at: [POOL_X1 - 15 - 1 / 32, 15 + 1 / 32, -127.5],
    vel: [0.25, -4, -45],
    ticks: 10,
    yaw: SOUTH,
  }),
  seg({ at: [POOL_X0 + 384, 256, -36], ticks: 45, yaw: NORTH, buttons: BUTTON_CROUCH }),
  seg({ ticks: 60, yaw: WEST, forward: FWD, right: LEFT }),
  ...ladderDrill(),
  ...swimDrill(),
];

/** Mode and event counts of a primer run, for tests: proof the script reaches what it claims. */
export class PrimerTally {
  ticks = 0;
  grounded = 0;
  crouched = 0;
  ladder = 0;
  swimming = 0;
  jumps = 0;
  steps = 0;
  lands = 0;
  /** Ticks run with the events attached, with the trace log attached, and traces it recorded. */
  withEvents = 0;
  withLog = 0;
  traces = 0;
}

/** The primer's own state: nothing here is shared with a match or a client. */
const scratchState = new PlayerState();
const scratchCmd = new UserCmd();
const scratchEvents = new PmoveEvents();
const scratchLog = new PmoveTraceLog();
const tallyEvent = new PmoveEvent();
const fileEvent = new PmoveEvent();
const eventSink = new Int32Array(1);

function startSegment(ps: PlayerState, at: Triple, vel: Triple | null): void {
  ps.origin[0] = at[0];
  ps.origin[1] = at[1];
  ps.origin[2] = at[2] - (HULL_MINS[2] as number) + TRACE_EPSILON;
  ps.velocity[0] = vel === null ? 0 : vel[0];
  ps.velocity[1] = vel === null ? 0 : vel[1];
  ps.velocity[2] = vel === null ? 0 : vel[2];
  ps.flags = 0;
  ps.groundEntity = ENTITY_NONE;
  ps.waterLevel = 0;
  quantizePlayerState(ps);
}

/**
 * Runs `ticks` ticks of PRIMER_SCRIPT (repeating it) on the primer's course with `params`, on the
 * primer's own scratch state. Each pass of the script runs with another pairing of events and
 * trace log attached, in the order play needs them: none (the predictor's replays), events (the
 * server, the predictor's first predictions), both (first predictions with debug draw), then the
 * log alone; PMOVE_PRIMER_TICKS (about 2.8 passes) reaches the first three. Fills `tally` when
 * given. Deterministic and allocation-free per tick.
 */
export function primePmove(
  params: Readonly<PmoveParams>,
  ticks: number,
  tally: PrimerTally | null = null,
): void {
  const world = buildPrimerWorld();
  const ps = scratchState;
  const cmd = scratchCmd;
  const events = scratchEvents;
  const log = scratchLog;
  const script = PRIMER_SCRIPT;
  let done = 0;
  for (let pass = 0; done < ticks; pass++) {
    // Passes 0–3: neither (a replay), events (the server, a first prediction), both (a first
    // prediction with debug draw), the trace log alone.
    const q = pass & 3;
    const ev = q === 1 || q === 2 ? events : null;
    const dbg = q >= 2 ? log : null;
    for (let s = 0; s < script.length && done < ticks; s++) {
      const g = script[s] as PrimerSegment;
      if (g.at !== null) startSegment(ps, g.at, g.vel);
      for (let t = 0; t < g.ticks && done < ticks; t++) {
        cmd.tick = done;
        cmd.forward = g.forward;
        cmd.right = g.right;
        cmd.up = g.up;
        cmd.yaw = (g.yaw + g.yawStep * t) & 0xffff;
        cmd.pitch = g.pitch & 0xffff;
        let buttons = g.buttons;
        if (g.jumpEvery > 0 && t % g.jumpEvery === 0) buttons |= BUTTON_JUMP;
        cmd.buttons = buttons;
        events.clear();
        log.clear();
        pmove(ps, cmd, world, params, TICK_DT, ev, dbg);
        done++;
        if (ev !== null) fileEvents(ev);
        if (tally !== null) countTick(tally, ps, ev, dbg);
      }
    }
  }
}

/**
 * Each event through entityEventValue, as the match files it into the world frame: its STEP
 * branch is first reached on the first stairs too. The sum only keeps the calls live.
 */
function fileEvents(ev: PmoveEvents): void {
  for (let i = 0; i < ev.count; i++) {
    eventSink[0] = ((eventSink[0] as number) + entityEventValue(ev.read(i, fileEvent))) & 0xffff;
  }
}

function countTick(
  tally: PrimerTally,
  ps: PlayerState,
  ev: PmoveEvents | null,
  dbg: PmoveTraceLog | null,
): void {
  tally.ticks++;
  if (dbg !== null) {
    tally.withLog++;
    tally.traces += dbg.total;
  }
  const f = ps.flags;
  if ((f & PMF_GROUNDED) !== 0) tally.grounded++;
  if ((f & PMF_CROUCHED) !== 0) tally.crouched++;
  if ((f & PMF_ON_LADDER) !== 0) tally.ladder++;
  if (ps.waterLevel >= 2) tally.swimming++;
  if (ev === null) return;
  tally.withEvents++;
  for (let i = 0; i < ev.count; i++) {
    const type = ev.read(i, tallyEvent).type;
    if (type === PMEV_JUMP) tally.jumps++;
    else if (type === PMEV_STEP) tally.steps++;
    else if (type === PMEV_LAND) tally.lands++;
  }
}

let primed = false;

/**
 * PMOVE_PRIMER_TICKS of the primer, once per module instance: the first Match or ClientSim in a
 * process (or a Worker) runs it and later ones skip it. Returns whether it ran now.
 */
export function primePmoveOnce(params: Readonly<PmoveParams>): boolean {
  if (primed) return false;
  primed = true;
  primePmove(params, PMOVE_PRIMER_TICKS);
  return true;
}

/** Whether this module instance has run primePmoveOnce. */
export function pmovePrimed(): boolean {
  return primed;
}
