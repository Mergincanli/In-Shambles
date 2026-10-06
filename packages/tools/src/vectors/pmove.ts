import {
  BUTTON_CROUCH,
  BUTTON_JUMP,
  BUTTON_WALK,
  boxPlanes,
  buildBrush,
  CONTENTS_SLICK,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  type CollisionBrushSource,
  type CollisionWorld,
  copyPlayerState,
  createCollisionWorld,
  degreesToU16,
  ENTITY_NONE,
  ENTITY_WORLD,
  lastPmoveSnap,
  MOVE_AXIS_MAX,
  Mulberry32,
  PlayerState,
  PMF_GROUNDED,
  PMOVE_CVARS,
  PmoveEvent,
  PmoveEvents,
  type PmoveParamField,
  PmoveParams,
  pmove,
  quantizePlayerState,
  rotatedBoxPlanes,
  SURF_LADDER,
  SURF_SLICK,
  sanitizeUserCmd,
  TICK_DT,
  TRACE_EPSILON,
  UserCmd,
  wedgePlanes,
} from "@game/shared";
import { brushRow, f64Hex, section } from "./rows";

/**
 * Renders packages/shared/test/vectors/pmove.ts (M2 plan, increment 6): a small fixed world as raw
 * plane bits, two frozen parameter sets, and one row per pmove tick, (state, cmd) → next state,
 * snap outcome and events. The rows come from short scripted runs in that world (walk, air, jump,
 * crouch, step, slope, rotated wall, slick ground, water, ladder, at 1/30, 1/60 and 1/120 s) plus
 * seeded sticky input. The scripts target the move modes and the branches the replay test's
 * coverage checks name; the pmove unit tests in packages/shared/test/sim/pmove cover the rest.
 * shared's test rebuilds the world and the parameters from the frozen bits and replays each row on
 * its own; `pnpm test:browser` replays it in real browsers (D-022), the browser leg of MV-19.
 */
export const PMOVE_VECTORS_FILE = ["packages", "shared", "test", "vectors", "pmove.ts"];

type Faces = (face: number) => number;

function brushOf(
  planes: Float64Array,
  contents = CONTENTS_SOLID,
  faces?: Faces,
): CollisionBrushSource {
  const b = buildBrush(planes);
  const planeCount = b.planes.length / 4;
  return {
    planes: b.planes,
    faceCount: b.faceCount,
    bounds: b.bounds,
    contents,
    surfaceFlags: Array.from({ length: planeCount }, (_, p) =>
      faces !== undefined && p < b.faceCount ? faces(p) : 0,
    ),
  };
}

// Box faces are ordered −x, +x, −y, +y, −z, +z (shapes.ts).
const FACE_MIN_X = 0;
const FACE_TOP = 5;

/** The vectors world. Floor top at z = 0; every feature stands on it, apart from the others. */
function pmoveWorldBrushes(): CollisionBrushSource[] {
  return [
    brushOf(boxPlanes([-1024, -1024, -64], [1024, 1024, 0])),
    // Steps: 16 u climbs, 19 u blocks (pm_stepSize 18).
    brushOf(boxPlanes([128, -320, 0], [256, -192, 16])),
    brushOf(boxPlanes([128, -160, 0], [256, -32, 19])),
    // A walkable slope (normal z 0.8) and a steep one (0.6925, under pm_minWalkNormal 0.7).
    brushOf(wedgePlanes([-512, -320, 0], [-256, -64, 192], "+x")),
    brushOf(boxPlanes([-256, -320, 0], [-128, -64, 192])),
    brushOf(wedgePlanes([-576, -32, 0], [-384, 160, 200], "+x")),
    // A wall turned 30° about z.
    brushOf(rotatedBoxPlanes([0, 352, 64], [128, 16, 64], Math.sqrt(3) / 2, 0.5)),
    // A deep pool (128 u), a wading strip (16 u), and a 40 u pool: waist deep standing (level 2),
    // over the eyes crouched (level 3).
    brushOf(boxPlanes([-448, 448, 0], [-192, 704, 128]), CONTENTS_WATER),
    brushOf(boxPlanes([-160, 448, 0], [-32, 704, 16]), CONTENTS_WATER),
    brushOf(boxPlanes([-160, 736, 0], [-32, 896, 40]), CONTENTS_WATER),
    // A wall whose −x face is a ladder (D-024).
    brushOf(boxPlanes([512, 256, 0], [576, 512, 320]), CONTENTS_SOLID, (f) =>
      f === FACE_MIN_X ? SURF_LADDER : 0,
    ),
    // A ceiling 44 u up: a crouched hull (40 u) fits under it, a standing one (56 u) does not.
    brushOf(boxPlanes([-128, -576, 44], [64, -384, 128])),
    // An 8 u platform with a slick top.
    brushOf(boxPlanes([384, -576, 0], [576, -384, 8]), CONTENTS_SOLID, (f) =>
      f === FACE_TOP ? SURF_SLICK : 0,
    ),
    // An 8 u platform slick by its contents bit, not a face flag (D-023).
    brushOf(boxPlanes([384, -320, 0], [576, -192, 8]), CONTENTS_SOLID | CONTENTS_SLICK),
    // A 48 u ledge: out of a rising player's step reach unless the ground is within pm_stepSize.
    brushOf(boxPlanes([384, -16, 0], [512, 112, 48])),
  ];
}

/** Parameter set 1: fractional tunings and auto-hop, as a live `set` would leave them. */
const TUNED: Partial<Record<PmoveParamField, number>> = {
  gravity: 400.5,
  jumpVelocity: 300.25,
  runSpeed: 333.5,
  autoHop: 1,
  ladderScale: 0.625,
  // A weak push leaves the hull within pm_ladderReach after a jump-off, so LADDER_DETACH_SPEED
  // decides whether it re-attaches.
  ladderJumpPush: 30.5,
  waterSinkSpeed: 45.5,
};

function paramSets(): PmoveParams[] {
  const tuned = new PmoveParams();
  for (const [field, value] of Object.entries(TUNED))
    tuned[field as PmoveParamField] = value as number;
  return [new PmoveParams(), tuned];
}

function paramsRow(p: PmoveParams): string {
  return PMOVE_CVARS.map((row) => `${row.field} ${f64Hex(p[row.field])}`).join(" ");
}

const REST_Z = 24 + TRACE_EPSILON;
/** Hull flush with the ladder face (x = 512): the facing check decides at any yaw. */
const LADDER_X = 512 - 15 - TRACE_EPSILON;
const EAST = 0;
const NORTH = degreesToU16(90);
const SOUTH = degreesToU16(270);
const LOOK_UP = degreesToU16(-30);
const LOOK_STEEP_UP = degreesToU16(-80);
const LOOK_STEEP_DOWN = degreesToU16(80);

interface Start {
  readonly at: readonly [number, number, number?];
  readonly yaw: number;
  readonly airborne?: boolean;
  readonly velocity?: readonly [number, number, number];
}

interface Script {
  readonly name: string;
  readonly start: Start;
  readonly ticks: number;
  /** Keep every n-th tick as a row, and every tick with an event (the run has every tick). */
  readonly every?: number;
  readonly params?: number;
  readonly dt?: number;
  /** Fills the move axes, buttons and angles of `c` for tick `t`. */
  readonly cmd: (t: number, c: UserCmd, ps: PlayerState) => void;
}

function setCmd(
  c: UserCmd,
  forward: number,
  right: number,
  buttons: number,
  yaw: number,
  pitch = 0,
) {
  c.forward = forward;
  c.right = right;
  c.up = 0;
  c.buttons = buttons;
  c.yaw = yaw;
  c.pitch = pitch;
}

const F = MOVE_AXIS_MAX;

const SCRIPTS: Script[] = [
  {
    name: "run, walk, coast to a stop",
    start: { at: [-100, -150], yaw: NORTH },
    ticks: 48,
    every: 3,
    cmd: (t, c) => setCmd(c, t < 36 ? F : 0, 0, t >= 20 && t < 36 ? BUTTON_WALK : 0, NORTH),
  },
  {
    name: "running jump and landing",
    start: { at: [-100, -150], yaw: NORTH },
    ticks: 56,
    every: 3,
    cmd: (t, c) => setCmd(c, F, 0, t >= 4 && t < 12 ? BUTTON_JUMP : 0, NORTH),
  },
  {
    name: "standing jump at 120 Hz",
    start: { at: [-100, -150], yaw: NORTH },
    ticks: 90,
    every: 3,
    dt: 1 / 120,
    cmd: (t, c) => setCmd(c, 0, 0, t < 2 ? BUTTON_JUMP : 0, NORTH),
  },
  {
    name: "strafe hops, turning",
    start: { at: [0, 0], yaw: EAST },
    ticks: 96,
    every: 3,
    cmd: (t, c, ps) => {
      const air = (ps.flags & PMF_GROUNDED) === 0;
      const jump = t >= 16 && !air && t % 2 === 0 ? BUTTON_JUMP : 0;
      setCmd(c, t < 16 ? F : 0, t < 16 ? 0 : t % 48 < 24 ? F : -F, jump, (t * 220) & 0xffff);
    },
  },
  {
    name: "step up 16",
    start: { at: [60, -256], yaw: EAST },
    ticks: 30,
    every: 2,
    cmd: (_t, c) => setCmd(c, F, 0, 0, EAST),
  },
  {
    name: "blocked by 19",
    start: { at: [60, -96], yaw: EAST },
    ticks: 24,
    every: 2,
    cmd: (_t, c) => setCmd(c, F, 0, 0, EAST),
  },
  {
    name: "up the walkable slope",
    start: { at: [-600, -192], yaw: EAST },
    ticks: 64,
    every: 3,
    cmd: (_t, c) => setCmd(c, F, 0, 0, EAST),
  },
  {
    name: "sliding down the steep slope",
    start: { at: [-480, 64, 142], yaw: EAST, airborne: true },
    ticks: 40,
    every: 2,
    cmd: (_t, c) => setCmd(c, 0, 0, 0, EAST),
  },
  {
    name: "running at the steep slope",
    start: { at: [-660, 64], yaw: EAST },
    ticks: 40,
    every: 2,
    cmd: (_t, c) => setCmd(c, F, 0, 0, EAST),
  },
  {
    name: "along the rotated wall",
    start: { at: [-60, 200], yaw: degreesToU16(105) },
    ticks: 40,
    every: 2,
    cmd: (_t, c) => setCmd(c, F, 0, 0, degreesToU16(105)),
  },
  {
    name: "crouch under the ceiling, stand and jump blocked",
    start: { at: [-16, -360], yaw: SOUTH },
    ticks: 60,
    every: 2,
    cmd: (t, c) =>
      setCmd(
        c,
        t < 40 ? F : 0,
        0,
        (t < 40 ? BUTTON_CROUCH : 0) | (t >= 46 ? BUTTON_JUMP : 0),
        SOUTH,
      ),
  },
  {
    name: "onto the slick platform and coast",
    start: { at: [300, -480], yaw: EAST },
    ticks: 50,
    every: 3,
    cmd: (t, c) => setCmd(c, t < 30 ? F : 0, 0, 0, EAST),
  },
  {
    name: "deep water: rest, swim, up, dive, surface",
    start: { at: [-320, 576], yaw: NORTH },
    ticks: 96,
    every: 3,
    cmd: (t, c) => {
      const buttons = (t >= 36 && t < 56) || t >= 74 ? BUTTON_JUMP : t >= 56 ? BUTTON_CROUCH : 0;
      setCmd(c, t >= 12 && t < 36 ? F : 0, 0, buttons, NORTH, LOOK_UP);
    },
  },
  {
    name: "sinking in deep water",
    start: { at: [-320, 576, 72], yaw: NORTH, airborne: true },
    ticks: 30,
    every: 2,
    cmd: (_t, c) => setCmd(c, 0, 0, 0, NORTH),
  },
  {
    name: "wading and jumping",
    start: { at: [-96, 520], yaw: NORTH },
    ticks: 36,
    every: 2,
    cmd: (t, c) => setCmd(c, F, 0, t === 10 ? BUTTON_JUMP : 0, NORTH),
  },
  {
    name: "ladder: climb, back, sideways, turn away, re-attach, jump off",
    start: { at: [LADDER_X, 384], yaw: EAST },
    ticks: 96,
    every: 3,
    cmd: (t, c) => {
      const away = t >= 62 && t < 72;
      const yaw = away ? degreesToU16(70) : EAST;
      const forward = t < 40 ? F : t < 54 ? -F : t >= 72 ? F : 0;
      const right = t >= 54 && t < 62 ? F : 0;
      setCmd(c, forward, right, t === 86 ? BUTTON_JUMP : 0, yaw, t < 40 ? LOOK_UP : 0);
    },
  },
  {
    name: "tuned parameters: auto-hop with jump held",
    start: { at: [0, -40], yaw: EAST },
    params: 1,
    ticks: 110,
    every: 4,
    cmd: (_t, c) => setCmd(c, F, 0, BUTTON_JUMP, EAST),
  },
  {
    name: "tuned parameters: ladder climb",
    start: { at: [LADDER_X, 300], yaw: EAST },
    params: 1,
    ticks: 24,
    every: 2,
    cmd: (_t, c) => setCmd(c, F, 0, 0, EAST, LOOK_UP),
  },
  {
    name: "ladder foot: back away, stand, walk on",
    start: { at: [LADDER_X, 440], yaw: EAST },
    ticks: 12,
    cmd: (t, c) => setCmd(c, t < 4 ? -F : t < 8 ? 0 : F, 0, 0, EAST),
  },
  {
    name: "tuned parameters: hop onto the ladder with jump held, weak push-offs",
    start: { at: [430, 384], yaw: EAST, velocity: [333.5, 0, 0] },
    params: 1,
    ticks: 40,
    cmd: (_t, c) => setCmd(c, F, 0, BUTTON_JUMP, EAST),
  },
  {
    name: "tuned parameters: sink, swim, dive in deep water",
    start: { at: [-320, 640, 72], yaw: NORTH, airborne: true },
    params: 1,
    ticks: 36,
    every: 2,
    cmd: (t, c) =>
      setCmd(c, t >= 12 && t < 24 ? F : 0, 0, t >= 24 ? BUTTON_CROUCH : 0, NORTH, LOOK_UP),
  },
  {
    name: "120 Hz: run, coast, wade",
    start: { at: [-96, 380], yaw: NORTH },
    ticks: 120,
    every: 4,
    dt: 1 / 120,
    cmd: (t, c) => setCmd(c, t < 70 ? F : 0, 0, 0, NORTH),
  },
  {
    name: "1/30 s: swim steeply up and down while strafing",
    start: { at: [-320, 576, 72], yaw: NORTH, airborne: true },
    ticks: 30,
    dt: 1 / 30,
    cmd: (t, c) => {
      const phase = Math.floor(t / 10);
      const pitch = phase === 1 ? LOOK_STEEP_DOWN : LOOK_STEEP_UP;
      setCmd(c, F, F, phase === 2 ? BUTTON_CROUCH : BUTTON_JUMP, NORTH, pitch);
    },
  },
  {
    name: "waist-deep water: stand, crouch under, stand",
    start: { at: [-96, 816], yaw: NORTH },
    ticks: 30,
    every: 2,
    cmd: (t, c) => setCmd(c, 0, t >= 20 ? F : 0, t >= 6 && t < 20 ? BUTTON_CROUCH : 0, NORTH),
  },
  {
    name: "accelerate from rest on the slick platform",
    start: { at: [480, -480, 8 + REST_Z], yaw: EAST },
    ticks: 20,
    every: 2,
    cmd: (_t, c) => setCmd(c, F, 0, 0, EAST),
  },
  {
    name: "coast on slick contents",
    start: { at: [420, -256, 8 + REST_Z], yaw: EAST, velocity: [200, 0, 0] },
    ticks: 20,
    every: 2,
    cmd: (_t, c) => setCmd(c, 0, 0, 0, EAST),
  },
  {
    name: "landing within the ground probe",
    start: { at: [-60, -250, REST_Z + 0.125], yaw: EAST, airborne: true, velocity: [200, 0, -100] },
    ticks: 4,
    cmd: (_t, c) => setCmd(c, F, 0, 0, EAST),
  },
  {
    name: "crouch-jump in the open, crouched air strafe",
    start: { at: [0, 100], yaw: EAST },
    ticks: 40,
    every: 2,
    cmd: (t, c) =>
      setCmd(c, t < 2 ? F : 0, t < 2 ? 0 : F, BUTTON_CROUCH | (t < 2 ? BUTTON_JUMP : 0), EAST),
  },
  {
    name: "rising into the 48 u ledge, no step",
    start: { at: [290, 48], yaw: EAST, velocity: [320, 0, 0] },
    ticks: 30,
    every: 2,
    cmd: (t, c) => setCmd(c, F, 0, t < 2 ? BUTTON_JUMP : 0, EAST),
  },
];

/**
 * Phases (u) for the crest runs: where a tick ends against the platform's lip varies, and only
 * some phases need the walk move's trace down past the stepped slide's rise (D-023).
 */
const PHASES = [0, 0.37, 0.71, 1.13, 1.5, 2.09, 2.6, 3.3];

function crestScripts(): Script[] {
  return PHASES.map((d) => ({
    name: `over the walkable slope's crest, phase ${d}`,
    // On the 0.8 slope (z = 0.75 (x + 512) under the hull's leading edge), at the run cap along it.
    start: {
      at: [-320 - d, -192, (207 - d) * 0.75 + REST_Z + 0.1],
      yaw: EAST,
      velocity: [256, 0, 192],
    },
    ticks: 24,
    every: 4,
    cmd: (_t, c) => setCmd(c, F, 0, 0, EAST),
  }));
}

/**
 * Starting points for the seeded segments, one segment each: the scripts' starts (steps, slopes,
 * the pools, the ladder, the ceiling, the slick platforms, the ledge) plus a few open spots.
 */
const SEEDED_STARTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [60, -256],
  [-600, -192],
  [-320, 576],
  [LADDER_X, 384],
  [-16, -300],
  [300, -480],
  [-60, 200],
  [-96, 816],
  [-96, 520],
  [-320, 640],
  [LADDER_X, 300],
  [330, 48],
  [330, -256],
  [-660, 64],
  [60, -96],
  [200, 200],
  [-200, 300],
  [700, 0],
  [0, -700],
];
const SEEDED_TICKS = 16;
export const PMOVE_VECTORS_SEED = 0x93e0;

/** Seeded sticky input (as the pmove bench and MV-19 draw it), a segment per starting point. */
function seededScripts(): Script[] {
  const rng = new Mulberry32(PMOVE_VECTORS_SEED);
  const scripts: Script[] = [];
  for (let s = 0; s < SEEDED_STARTS.length; s++) {
    const at = SEEDED_STARTS[s] as readonly [number, number];
    const yaw0 = rng.nextInt(4) * 16384;
    // Draw the whole segment now, so the script is a pure table lookup.
    const table: number[][] = [];
    let hold = 0;
    let forward = 0;
    let right = 0;
    let buttons = 0;
    let yawRate = 0;
    let pitch = 0;
    let yaw = yaw0;
    for (let t = 0; t < SEEDED_TICKS; t++) {
      if (hold-- <= 0) {
        hold = 3 + rng.nextInt(10);
        forward = [F, F, 0, -F][rng.nextInt(4)] as number;
        right = [0, F, -F][rng.nextInt(3)] as number;
        buttons =
          (rng.nextFloat() < 0.3 ? BUTTON_JUMP : 0) |
          (rng.nextFloat() < 0.2 ? BUTTON_CROUCH : 0) |
          (rng.nextFloat() < 0.15 ? BUTTON_WALK : 0);
        yawRate = rng.nextInt(1201) - 600;
        pitch = rng.nextInt(24001) - 12000;
      }
      yaw = (yaw + yawRate) & 0xffff;
      table.push([forward, right, buttons, yaw, pitch & 0xffff]);
    }
    scripts.push({
      name: `seeded segment ${s}`,
      start: { at, yaw: yaw0 },
      ticks: SEEDED_TICKS,
      cmd: (t, c) => {
        const row = table[t] as number[];
        setCmd(c, row[0] as number, row[1] as number, row[2] as number, row[3] as number, row[4]);
      },
    });
  }
  return scripts;
}

function stateFields(ps: PlayerState): string[] {
  return [
    ...[...ps.origin, ...ps.velocity].map(f64Hex),
    `${ps.viewYaw}`,
    `${ps.viewPitch}`,
    `${ps.flags}`,
    `${ps.groundEntity}`,
    `${ps.waterLevel}`,
    `${ps.stamina}`,
  ];
}

function cmdFields(c: UserCmd): string[] {
  return [c.tick, c.buttons, c.forward, c.right, c.up, c.yaw, c.pitch, c.weaponSlot].map(String);
}

function scriptRows(world: CollisionWorld, sets: PmoveParams[], script: Script): string[] {
  const ps = new PlayerState();
  const before = new PlayerState();
  const c = new UserCmd();
  const ev = new PmoveEvents();
  const e = new PmoveEvent();
  const params = sets[script.params ?? 0] as PmoveParams;
  const dt = script.dt ?? TICK_DT;
  const [x, y, z] = script.start.at;
  ps.origin[0] = x;
  ps.origin[1] = y;
  ps.origin[2] = z ?? REST_Z;
  const v = script.start.velocity;
  if (v !== undefined) for (let k = 0; k < 3; k++) ps.velocity[k] = v[k] as number;
  ps.viewYaw = script.start.yaw;
  ps.flags = script.start.airborne === true ? 0 : PMF_GROUNDED;
  ps.groundEntity = script.start.airborne === true ? ENTITY_NONE : ENTITY_WORLD;
  ps.stamina = 100 * 100;
  quantizePlayerState(ps);
  const rows: string[] = [];
  for (let t = 0; t < script.ticks; t++) {
    copyPlayerState(before, ps);
    script.cmd(t, c, ps);
    c.tick = t;
    c.weaponSlot = 0;
    sanitizeUserCmd(c);
    ev.clear();
    pmove(ps, c, world, params, dt, ev, null);
    if (t % (script.every ?? 1) !== 0 && ev.count === 0) continue;
    const events: string[] = [`${ev.count}`];
    for (let k = 0; k < ev.count; k++) {
      ev.read(k, e);
      events.push(`${e.type}`, f64Hex(e.value));
    }
    rows.push(
      [
        `${script.params ?? 0}`,
        f64Hex(dt),
        ...stateFields(before),
        ...cmdFields(c),
        ...stateFields(ps),
        `${lastPmoveSnap()}`,
        ...events,
      ].join(" "),
    );
  }
  return rows;
}

/** Every scripted run's name and rows, in file order. */
export function pmoveVectorRuns(): { name: string; rows: string[] }[] {
  const world = createCollisionWorld(pmoveWorldBrushes());
  const sets = paramSets();
  return [...SCRIPTS, ...crestScripts(), ...seededScripts()].map((s) => {
    try {
      return { name: s.name, rows: scriptRows(world, sets, s) };
    } catch (error) {
      throw new Error(`pmove vectors, run "${s.name}"`, { cause: error });
    }
  });
}

export function renderPmoveVectors(): string {
  const brushes = pmoveWorldBrushes();
  const sets = paramSets();
  const rows = pmoveVectorRuns().flatMap((run) => run.rows);
  return [
    "// GENERATED by packages/tools/src/vectors/pmove.ts. Do not edit by hand.",
    "// Regenerate with `pnpm --filter @game/tools vectors`. A diff here means pmove changed bits:",
    "// say why in the change (D-016, D-017, D-023, D-024).",
    "//",
    "// Frozen input → output bits for single pmove ticks on a small fixed world. Fields as in",
    "// trace.ts: f64 as 16 hex digits of the IEEE-754 bits, u32 as 8 hex digits, integers in",
    "// decimal. A state is origin, velocity (f64), viewYaw, viewPitch, flags, groundEntity,",
    "// waterLevel, stamina (decimal); a cmd is tick, buttons, forward, right, up, yaw, pitch,",
    "// weaponSlot (decimal, already sanitized). Plain JavaScript (no imports, no type",
    "// annotations), so browsers load it as is (D-022).",
    "",
    section(
      "PMOVE_WORLD",
      "One brush per row, as TRACE_WORLD: contents, faceCount, planeCount (decimal), bounds (6 f64), planes (nx ny nz d per plane, f64), surface flags per plane (u32)",
      brushes.map(brushRow),
    ),
    section(
      "PMOVE_PARAMS",
      "One parameter set per row: (PmoveParams field, value f64) pairs in PMOVE_CVARS order. Set 0 is the defaults",
      sets.map(paramsRow),
    ),
    section(
      "PMOVE_VECTORS",
      "params set (decimal), dt (f64), state, cmd, then pmove's next state, lastPmoveSnap() (decimal), and the events: count, then type (decimal) and value (f64) per event",
      rows,
    ),
  ].join("\n");
}
