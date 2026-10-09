import { PerformanceObserver } from "node:perf_hooks";
import {
  ClientNetSettings,
  ClientSim,
  JM_CHECKED,
  NetStats,
  type PortLike,
  PortTransport,
  RandomWalk,
  RemoteInterpolator,
  RemoteJumpMeter,
  RouteInput,
  SnapshotStore,
  type SocketLike,
  STAT_CLOCK_ADJUSTMENTS,
  STAT_CORRECTIONS,
  STAT_HARD_RESYNCS,
  STAT_REMOTE_EVENTS,
  STAT_REMOTE_EXTRAPOLATED,
  STAT_REMOTE_HELD,
  STAT_TELEPORTS,
  STORE_NO_BASELINE,
  STORE_STORED,
  StrafeCircuit,
  WebSocketTransport,
} from "@game/client/net";
import { LoopStats, Match, type Session, TickHistogram } from "@game/server";
import {
  type PassClock,
  type ServerMatch,
  TimedPass,
  WireTraffic,
  WsLimits,
  type WsSocket,
  WsTransport,
} from "@game/server/node";
import {
  ACCEL_AIR,
  ACCEL_GROUND,
  accelerate,
  applyFriction,
  BitReader,
  BitWriter,
  BUTTON_ATTACK,
  BUTTON_CROUCH,
  BUTTON_JUMP,
  BUTTON_WALK,
  boxContents,
  boxPlanes,
  buildBrush,
  type CloseHandler,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  type CollisionBrushSource,
  CvarRegistry,
  clipVelocity,
  cmdScale,
  copyPlayerState,
  copySlot,
  createCollisionWorld,
  createLoopbackPair,
  decodeInput,
  decodePing,
  decodePong,
  decodeSnapshotBody,
  decodeSnapshotHeader,
  ENTITY_NEW_BITS,
  encodeHello,
  encodeInput,
  encodePing,
  encodePong,
  encodeReady,
  encodeSnapshot,
  entityEquals,
  entityVelocity,
  FRAME_SLOTS,
  FrameRing,
  findNetProfile,
  HelloMsg,
  HULL_CROUCHED_MAXS,
  HULL_MINS,
  HULL_STANDING_MAXS,
  InputMsg,
  type LoopbackEndpoint,
  MASK_PLAYERSOLID,
  MAX_RELIABLE_BYTES,
  MAX_UNRELIABLE_BYTES,
  type MessageHandler,
  MSG_CMD,
  MSG_INPUT,
  MSG_PING,
  MSG_PONG,
  MSG_SNAPSHOT,
  Mulberry32,
  type NetProfile,
  NetSimTransport,
  PingMsg,
  PlayerState,
  PlayerStateRing,
  PMEV_LAND,
  PMEV_STEP,
  PMF_CROUCHED,
  PMF_GROUNDED,
  PMF_ON_LADDER,
  PMOVE_CVARS,
  PmoveEvent,
  PmoveEvents,
  PmoveParams,
  PmoveTraceLog,
  PongMsg,
  peekMessageType,
  playerStateEquals,
  playerStateToSlot,
  pmove,
  pointContents,
  positionContents,
  positionTest,
  pushEntityEvent,
  quantizePlayerState,
  refreshPmoveParams,
  registerPmoveCvars,
  rotatedBoxPlanes,
  SNAP_FLAG_STARVED,
  SNAP_FULL_FIXED_BITS,
  SnapshotHeader,
  SURF_LADDER,
  sanitizeUserCmd,
  slotToPlayerState,
  snapOrigin,
  TICK_DT,
  TraceResult,
  type Transport,
  type TransportStats,
  traceBox,
  traceRay,
  UserCmd,
  type Vec3,
  vec3,
  WorldFrame,
  wedgePlanes,
} from "@game/shared";
import { ARENA_RING } from "../../src/bots/routes";
import { HoldInput, HopForward, StrafeHop } from "../../src/scenarios/bots";
import { anchorYawU16, courseAnchor, loadCourse } from "../../src/scenarios/course";
import { placeAtAnchor, ScenarioRecord, ScenarioRunner } from "../../src/scenarios/runner";

// Child process for long/native-esm-allocation.long.ts (`pnpm test:long`, D-032): `node --import
// tsx` loads shared as native ES modules, as dev:server and bench do. There V8 boxes doubles that
// the Vitest module runner and the bundle keep unboxed, so the in-process allocation test cannot
// see it. Prints one JSON line.

const CALLS = 200_000;
const CASES = 1024;

function solid(planes: Float64Array): CollisionBrushSource {
  const b = buildBrush(planes);
  return { planes: b.planes, faceCount: b.faceCount, bounds: b.bounds, contents: CONTENTS_SOLID };
}

const world = createCollisionWorld([
  solid(boxPlanes([-512, -512, -64], [512, 512, 0])),
  solid(wedgePlanes([0, -256, 0], [256, 256, 96], "+x")),
  solid(rotatedBoxPlanes([-200, 0, 48], [64, 12, 48], 0.6, 0.8)),
]);

const rng = new Mulberry32(0x5eed);
const exact: Vec3[] = [];
const ps = new PlayerState();
const tr = new TraceResult();
const from = vec3();
const to = vec3();
for (let i = 0; i < CASES; i++) {
  const x = rng.nextFloat() * 600 - 300;
  const y = rng.nextFloat() * 400 - 200;
  if (i % 4 === 3) {
    // Inside the floor: every corner is solid, so the snap falls back to the previous origin.
    exact.push(vec3(x, y, rng.nextFloat() * 20));
  } else {
    // Dropped onto the floor, the slope or the rotated box: a stop in the ε skin.
    from[0] = x;
    from[1] = y;
    from[2] = 200;
    to[0] = x + rng.nextFloat() * 40 - 20;
    to[1] = y;
    to[2] = -100;
    traceBox(world, from, to, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID, tr);
    // Every other stop is pushed a little into the surface, so on the slope and the rotated box
    // the rounded point is solid and a corner of its grid cell is not.
    const sink = (i & 1) === 0 ? 0 : rng.nextFloat() * 0.04;
    exact.push(vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2] - sink));
  }
}
const prev = vec3(0, 400, 24);
const out = vec3();
const outcomes = new Int32Array(3);
/** A workload's further outcomes (wsTransport: the client end's). */
const extra = new Int32Array(4);

function runQuantize(n: number): void {
  const o = ps.origin;
  const v = ps.velocity;
  for (let i = 0; i < n; i++) {
    const e = exact[i & (CASES - 1)] as Vec3;
    o[0] = e[0];
    o[1] = e[1];
    o[2] = e[2];
    v[0] = e[1] * 3.3;
    v[1] = -e[0] * 1.7;
    v[2] = e[2] * 0.1;
    ps.viewYaw = i;
    ps.stamina = i & 4095;
    quantizePlayerState(ps);
  }
}

function runSnap(n: number): void {
  for (let i = 0; i < n; i++) {
    const e = exact[i & (CASES - 1)] as Vec3;
    const r = snapOrigin(world, e, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID, prev, out);
    outcomes[r] = (outcomes[r] as number) + 1;
  }
}

const ring = new PlayerStateRing();
const ps2 = new PlayerState();
const cmd = new UserCmd();

/** Ring write/read (copy), the prediction compare and a cmd sanitize. */
function runState(n: number): void {
  for (let i = 0; i < n; i++) {
    const e = exact[i & (CASES - 1)] as Vec3;
    ps.origin[0] = e[0];
    ps.stamina = i & 4095;
    ring.write(i, ps);
    if (ring.has(i - 1) && ring.read(i - 1, ps2) && !playerStateEquals(ps, ps2)) {
      outcomes[0] = (outcomes[0] as number) + 1;
    }
    copyPlayerState(ps2, ps);
    if (playerStateEquals(ps, ps2)) outcomes[1] = (outcomes[1] as number) + 1;
    // Out-of-range integers, as a wire decoder hands them over.
    cmd.tick = i;
    cmd.buttons = i;
    cmd.forward = (i & 511) - 256;
    cmd.right = (i & 255) - 300;
    cmd.up = i & 127;
    cmd.yaw = i * 7;
    cmd.pitch = (i * 13) & 0x1ffff;
    cmd.weaponSlot = (i & 15) - 4;
    sanitizeUserCmd(cmd);
    outcomes[2] = (outcomes[2] as number) + (cmd.forward & 1);
  }
}

const lo = vec3();
const hi = vec3();

/** The BVH query mix of trace-allocation.test.ts, here as native ESM. */
function runTrace(n: number): void {
  for (let i = 0; i < n; i++) {
    const e = exact[i & (CASES - 1)] as Vec3;
    const s = exact[(i + 1) & (CASES - 1)] as Vec3;
    switch (i % 5) {
      case 0:
        traceBox(world, s, e, HULL_MINS, HULL_CROUCHED_MAXS, MASK_PLAYERSOLID, tr);
        if (tr.fraction < 1) outcomes[0] = (outcomes[0] as number) + 1;
        break;
      case 1:
        traceRay(world, s, e, -1, tr);
        if (tr.fraction < 1) outcomes[0] = (outcomes[0] as number) + 1;
        break;
      case 2:
        if (!positionTest(world, e, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID)) {
          outcomes[1] = (outcomes[1] as number) + 1;
        }
        outcomes[1] =
          (outcomes[1] as number) +
          (positionContents(world, s, HULL_MINS, HULL_CROUCHED_MAXS, -1) & 1);
        break;
      case 3:
        outcomes[2] = (outcomes[2] as number) + (pointContents(world, e) & 1);
        break;
      default:
        lo[0] = e[0] - 16;
        lo[1] = e[1] - 16;
        lo[2] = e[2] - 64;
        hi[0] = e[0] + 16;
        hi[1] = e[1] + 16;
        hi[2] = e[2];
        outcomes[2] = (outcomes[2] as number) + (boxContents(world, lo, hi) & 1);
    }
  }
}

const cvars = new CvarRegistry();
registerPmoveCvars(cvars);
// Non-integer values: a double store that boxes shows up here, a small integer would not.
for (let i = 0; i < PMOVE_CVARS.length; i++) {
  const r = PMOVE_CVARS[i] as (typeof PMOVE_CVARS)[number];
  if (r.type === "float") cvars.set(r.name, r.min + (r.max - r.min) * 0.37);
}
const params = new PmoveParams();
const vel = vec3();
const wish = vec3();
const normal = vec3(0.6, 0, 0.8);

/** A forced refresh every 16 calls, the unchanged check on the rest, and the docs/03 §4 steps. */
function runPmoveBasics(n: number): void {
  for (let i = 0; i < n; i++) {
    const e = exact[i & (CASES - 1)] as Vec3;
    if ((i & 15) === 0) params.version = -1;
    if (refreshPmoveParams(cvars, params)) outcomes[0] = (outcomes[0] as number) + 1;
    cmd.forward = (i & 255) - 128;
    cmd.right = ((i * 7) & 255) - 128;
    cmd.buttons = i & BUTTON_WALK;
    cmdScale(wish, cmd, 0, (i & 2) !== 0, params);
    vel[0] = e[0];
    vel[1] = e[1];
    vel[2] = e[2] - 50;
    accelerate(vel, wish, (i & 4) === 0 ? ACCEL_GROUND : ACCEL_AIR, params, 1 / 60);
    applyFriction(vel, (i & 1) === 0, (i & 8) !== 0, (i >> 4) & 3, params, 1 / 60);
    clipVelocity(vel, vel, normal, params);
    if (vel[2] + wish[0] > 0) outcomes[1] = (outcomes[1] as number) + 1;
    else outcomes[2] = (outcomes[2] as number) + 1;
  }
}

// A walled room with a slope, a rotated wall, an 18 u step and a 16 u step, for the whole tick.
const room = createCollisionWorld([
  solid(boxPlanes([-512, -512, -64], [512, 512, 0])),
  solid(boxPlanes([-544, -544, 0], [-512, 544, 256])),
  solid(boxPlanes([512, -544, 0], [544, 544, 256])),
  solid(boxPlanes([-544, -544, 0], [544, -512, 256])),
  solid(boxPlanes([-544, 512, 0], [544, 544, 256])),
  solid(wedgePlanes([0, -256, 0], [256, 0, 200], "+x")),
  solid(rotatedBoxPlanes([-200, 200, 48], [96, 12, 48], 0.6, 0.8)),
  solid(boxPlanes([100, 150, 0], [300, 350, 18])),
  solid(boxPlanes([-350, -350, 0], [-150, -150, 16])),
]);
const pps = new PlayerState();
const pcmd = new UserCmd();
const events = new PmoveEvents();
const traceLog = new PmoveTraceLog();
// Refreshed from a registry with fractional values, as the game does: the fields then hold
// doubles, which V8 represents differently from the integer defaults.
const pmoveCvars = new CvarRegistry();
registerPmoveCvars(pmoveCvars);
pmoveCvars.set("pm_gravity", 799.5);
pmoveCvars.set("pm_runSpeed", 320.25);
pmoveCvars.set("pm_accelerate", 10.5);
pmoveCvars.set("pm_stepSize", 18.5);
const pmoveParams = new PmoveParams();
refreshPmoveParams(pmoveCvars, pmoveParams);
const eventOut = new PmoveEvent();

/**
 * Whole pmove ticks: walk, strafe, jump, walk-modifier and crouched-hull input over slopes,
 * steps and walls, with the events ring and (every other tick) the trace log attached.
 */
function runPmove(n: number): void {
  for (let i = 0; i < n; i++) {
    if ((i & 511) === 0) {
      pps.origin[0] = ((i >> 9) & 7) * 40 - 140;
      pps.origin[1] = 100;
      pps.origin[2] = 24;
      pps.velocity[0] = 0;
      pps.velocity[1] = 0;
      pps.velocity[2] = 0;
      pps.flags = PMF_GROUNDED;
    }
    pcmd.forward = (i & 64) === 0 ? 127 : -90;
    pcmd.right = ((i >> 5) & 3) * 60 - 90;
    pcmd.buttons = ((i & 31) === 0 ? BUTTON_JUMP : 0) | ((i & 256) !== 0 ? BUTTON_WALK : 0);
    pcmd.yaw = (i * 97) & 0xffff;
    pcmd.pitch = (i * 31) & 0x3fff;
    if ((i & 1023) >= 512) pcmd.buttons |= BUTTON_CROUCH;
    pmove(pps, pcmd, room, pmoveParams, TICK_DT, events, (i & 1) === 0 ? traceLog : null);
    if ((pps.flags & PMF_GROUNDED) !== 0) outcomes[0] = (outcomes[0] as number) + 1;
    else outcomes[1] = (outcomes[1] as number) + 1;
    for (let k = 0; k < events.count; k++) {
      events.read(k, eventOut);
      if (eventOut.type === PMEV_STEP || eventOut.type === PMEV_LAND) {
        outcomes[2] = (outcomes[2] as number) + 1;
      }
    }
    events.clear();
    if ((i & 63) === 0) traceLog.clear();
  }
}

// A ladder face (the −y side of a wall), a deep pool and open floor for the M2 movement modes.
const modes = createCollisionWorld([
  solid(boxPlanes([-1024, -1024, -64], [1024, 1024, 0])),
  {
    ...solid(boxPlanes([-128, 200, 0], [128, 264, 512])),
    surfaceFlags: [0, 0, SURF_LADDER, 0, 0, 0],
  },
  { ...solid(boxPlanes([300, -200, 0], [600, 200, 300])), contents: CONTENTS_WATER },
]);
/** u16 yaw facing +y, the ladder face. */
const YAW_NORTH = 16384;

/**
 * Whole pmove ticks in the M2 modes (D-024): climbing, descending, strafing, turning off and
 * jumping off the ladder; swimming, sinking, rising and diving in the pool; crouching and
 * standing on open floor. Outcomes: ladder ticks, swim ticks (water level ≥ 2), crouched ticks.
 */
function runPmoveModes(n: number): void {
  for (let i = 0; i < n; i++) {
    const phase = ((i / 600) % 3) | 0;
    const t = i % 600;
    if (t === 0) {
      pps.velocity[0] = 0;
      pps.velocity[1] = 0;
      pps.velocity[2] = 0;
      pps.flags = PMF_GROUNDED;
      pps.waterLevel = 0;
      pps.origin[2] = 24;
      if (phase === 0) {
        pps.origin[0] = ((i >> 4) & 63) - 32;
        pps.origin[1] = 200 - 16;
      } else if (phase === 1) {
        pps.origin[0] = 450;
        pps.origin[1] = 0;
        pps.origin[2] = 150;
        pps.flags = 0;
      } else {
        pps.origin[0] = -400;
        pps.origin[1] = 0;
      }
    }
    pcmd.right = 0;
    pcmd.pitch = (i * 31) & 0x3fff;
    if (phase === 0) {
      pcmd.forward = t < 240 ? 127 : t < 300 ? -127 : t < 360 ? 0 : 127;
      pcmd.right = t >= 300 && t < 360 ? 127 : 0;
      pcmd.buttons = t === 420 ? BUTTON_JUMP : 0;
      // Turns past the facing limit and back.
      pcmd.yaw = (YAW_NORTH + (t >= 200 && t < 230 ? 12000 : (t & 7) * 900)) & 0xffff;
    } else if (phase === 1) {
      pcmd.forward = (t & 64) === 0 ? 127 : 0;
      pcmd.buttons = (t & 128) !== 0 ? BUTTON_JUMP : (t & 256) !== 0 ? BUTTON_CROUCH : 0;
      pcmd.yaw = (i * 97) & 0xffff;
    } else {
      pcmd.forward = 127;
      pcmd.buttons = (t & 32) !== 0 ? BUTTON_CROUCH : 0;
      pcmd.yaw = (i * 53) & 0xffff;
    }
    pmove(pps, pcmd, modes, pmoveParams, TICK_DT, events, (i & 1) === 0 ? traceLog : null);
    if ((pps.flags & PMF_ON_LADDER) !== 0) outcomes[0] = (outcomes[0] as number) + 1;
    if (pps.waterLevel >= 2) outcomes[1] = (outcomes[1] as number) + 1;
    if ((pps.flags & PMF_CROUCHED) !== 0) outcomes[2] = (outcomes[2] as number) + 1;
    events.clear();
    if ((i & 63) === 0) traceLog.clear();
  }
}

/** The scenario harness (D-025), built on first use so the other workloads skip the map load. */
let scenario: {
  runner: ScenarioRunner;
  start: ReturnType<typeof courseAnchor>;
  record: ScenarioRecord;
  hold: HoldInput;
  walk: HoldInput;
  hop: HopForward;
  strafe: StrafeHop;
} | null = null;

function scenarioHarness() {
  if (scenario === null) {
    const course = loadCourse("movement_lab");
    const runner = new ScenarioRunner(course.world);
    const start = courseAnchor(course, "open_sw");
    const yaw = anchorYawU16(start);
    scenario = {
      runner,
      start,
      record: new ScenarioRecord(1024, TICK_DT),
      hold: new HoldInput(yaw),
      walk: new HoldInput(yaw, { buttons: BUTTON_WALK, right: 64 }),
      hop: new HopForward(yaw, { runUpTicks: 0, hops: Number.MAX_SAFE_INTEGER }),
      strafe: new StrafeHop(yaw, runner.params, runner.dt, {
        runUpTicks: 0,
        hops: Number.MAX_SAFE_INTEGER,
      }),
    };
  }
  return scenario;
}

/**
 * Scenario runner ticks on movement_lab from open_sw, in 1000-tick runs held forward, walked
 * with a strafe, and hopped: the runner's own recording must add nothing to pmove.
 */
function runScenario(n: number): void {
  const h = scenarioHarness();
  const ps = pps;
  for (let done = 0, run = 0; done < n; done += 1000, run++) {
    placeAtAnchor(ps, h.start);
    h.record.clear();
    h.record.push(ps);
    const source = run % 3 === 0 ? h.hold : run % 3 === 1 ? h.walk : h.hop;
    h.runner.continue(ps, source, Math.min(1000, n - done), h.record);
    outcomes[run % 3] = (outcomes[run % 3] as number) + h.record.count + h.record.eventCount;
  }
}

/**
 * The strafe bot's per-tick choice (a 65536-yaw search, so a hundredth as many calls), grounded
 * and airborne at changing velocities, both sides.
 */
function runStrafeBot(n: number): void {
  const h = scenarioHarness();
  const ps = pps;
  const calls = n / 100;
  for (let i = 0; i < calls; i++) {
    ps.flags = i % 41 === 0 ? PMF_GROUNDED : 0;
    ps.velocity[0] = 300.5 + (i & 255) * 1.25;
    ps.velocity[1] = (i & 63) * 3.5 - 100;
    ps.velocity[2] = 0;
    h.strafe.next(pcmd, ps);
    outcomes[pcmd.right > 0 ? 0 : 1] = (outcomes[pcmd.right > 0 ? 0 : 1] as number) + 1;
    outcomes[2] = (outcomes[2] as number) + (pcmd.yaw & 1);
  }
}

// The bots' cmd sources (M3 increment 6, D-036), as each bot samples one per tick: a strafe-jump
// route over arena_greybox's ring on synthetic states that circle the yard (waypoints reached),
// stand still now and then (the stuck detector fires and random-walks out), land and take off;
// and a random walk on its own.
const botRoute = new RouteInput(ARENA_RING, 5, { idleTicks: 0 });
const botWalk = new RandomWalk(6, { idleTicks: 0 });
const botState = new PlayerState();

/** Ticks `from` … `to` − 1 of the bot workload's script (whole-function optimized, not OSR). */
function botTicks(from: number, to: number): void {
  const ps = botState;
  for (let i = from; i < to; i++) {
    const k = i % 4000;
    // A lap of the ring in 3600 ticks, then 400 ticks standing still.
    const a = (Math.min(k, 3600) / 3600) * 2 * Math.PI;
    const moving = k < 3600 ? 1 : 0;
    ps.origin[0] = 900 * Math.cos(a);
    ps.origin[1] = 560 * Math.sin(a);
    ps.velocity[0] = -500 * moving * Math.sin(a);
    ps.velocity[1] = 300 * moving * Math.cos(a);
    ps.flags = (i & 31) < 3 ? PMF_GROUNDED : 0;
    botRoute.sample(pcmd, ps);
    botWalk.sample(pcmd, ps);
  }
}

function runBotInput(n: number): void {
  for (let i = 0; i < n; i += 1000) botTicks(i, Math.min(n, i + 1000));
  outcomes[0] = botRoute.reached;
  outcomes[1] = botRoute.stuckEvents;
  outcomes[2] = botRoute.stuckTicks;
}

const codecWriter = new BitWriter(MAX_UNRELIABLE_BYTES);
const codecReader = new BitReader();
/** A 16-player world frame (D-033): each SNAPSHOT is one receiver's view of it. */
const CODEC_PLAYERS = 16;
const snapHeader = new SnapshotHeader();
const snapFrame = new WorldFrame();
const snapGotHeader = new SnapshotHeader();
const snapGotFrame = new WorldFrame();
const snapState = new PlayerState();
const snapGotState = new PlayerState();
for (let p = 0; p < CODEC_PLAYERS; p++) {
  snapFrame.setPresent(p, 1);
  snapState.origin[0] = p * 64;
  playerStateToSlot(snapFrame, p, snapState);
}
snapHeader.serverTick = 1;
const inputSent = new InputMsg();
const inputGot = new InputMsg();
const pingSent = new PingMsg();
const pingGot = new PingMsg();
const pongSent = new PongMsg();
const pongGot = new PongMsg();

/**
 * Packets the decoders must refuse, as a server sees from a broken or hostile client: random
 * bytes behind an INPUT, SNAPSHOT or PONG type byte, and valid messages with a u32 tick set to
 * 2^32 − 1 (a value that would box if a decoder stored it before checking it) or, for SNAPSHOT,
 * one field inside an entity record set out of range, so the decoder refuses it after reading
 * whole records: an id past 63, then a later record's team 3, pitch past ±16201 or event kind 15.
 * Built once.
 */
const HOSTILE_COUNT = 64;
const hostile: Uint8Array[] = [];
const hostileTypes = [MSG_INPUT, MSG_SNAPSHOT, MSG_PONG];
/** Bit offset of field `field` in entity record `k` (docs/05 §3.6: records start at 292). */
const recordBit = (k: number, field: number) => SNAP_FULL_FIXED_BITS + k * ENTITY_NEW_BITS + field;
/** [bit offset, width, value] of each record-level SNAPSHOT corruption, in turn. */
const SNAPSHOT_CORRUPTIONS: readonly (readonly [number, number, number])[] = [
  [recordBit(0, 0), 16, 0xffff], // id
  [recordBit(7, 171), 2, 3], // team
  [recordBit(11, 145), 16, 0x7fff], // pitch
  [recordBit(14, 189), 4, 15], // first event kind
];
let snapshotCorruption = 0;
/** Overwrites `width` bits at bit `offset` of `bytes` with `value` (LSB-first, as BitWriter). */
function patchBits(bytes: Uint8Array, offset: number, width: number, value: number): void {
  for (let b = 0; b < width; b++) {
    const bit = offset + b;
    const mask = 1 << (bit & 7);
    const byte = bytes[bit >> 3] as number;
    bytes[bit >> 3] = ((value >>> b) & 1) === 1 ? byte | mask : byte & ~mask;
  }
}
for (let i = 0; i < HOSTILE_COUNT; i++) {
  const type = hostileTypes[i % 3] as number;
  if (i < HOSTILE_COUNT / 2) {
    const bytes = new Uint8Array(1 + rng.nextInt(64));
    for (let b = 0; b < bytes.length; b++) bytes[b] = rng.nextInt(256);
    bytes[0] = type;
    hostile.push(bytes);
    continue;
  }
  codecWriter.reset();
  if (type === MSG_INPUT) {
    inputSent.count = 1;
    encodeInput(codecWriter, inputSent);
  } else if (type === MSG_SNAPSHOT) {
    encodeSnapshot(codecWriter, snapHeader, snapFrame, null, 3);
  } else {
    encodePong(codecWriter, pongSent);
  }
  const bytes = codecWriter.bytes.slice(0, codecWriter.byteLength);
  if (type === MSG_SNAPSHOT && (i & 1) === 1) {
    const c = SNAPSHOT_CORRUPTIONS[snapshotCorruption++ % SNAPSHOT_CORRUPTIONS.length] as readonly [
      number,
      number,
      number,
    ];
    patchBits(bytes, c[0], c[1], c[2]);
  } else {
    // INPUT lastSnapshotTick and PONG serverTick at byte 3, SNAPSHOT serverTick at byte 1.
    const at = type === MSG_SNAPSHOT ? 1 : 3;
    bytes.fill(0xff, at, at + 4);
  }
  hostile.push(bytes);
}
/** Hostile packets refused (all of them, when the decoders work). */
const codecRejected = new Int32Array(1);

/**
 * The per-tick messages (D-026, D-033): SNAPSHOT (a full v2 snapshot of a 16-player frame whose
 * players take quantized states with fractional origin and velocity, written into the frame as the
 * match captures them, for a rotating receiver; decoded header then body as the client's store
 * does), INPUT with 1–4 cmds, PING and PONG, each encoded, dispatched on its type byte and
 * decoded, then one hostile packet, which must be refused without allocating either. Outcomes:
 * snapshots (the receiver's state back exactly), inputs, pings and pongs that came back equal;
 * `codecRejected` counts the refusals.
 */
function runCodec(n: number): void {
  const w = codecWriter;
  const r = codecReader;
  for (let i = 0; i < n; i++) {
    const e = exact[i & (CASES - 1)] as Vec3;
    const kind = i & 3;
    w.reset();
    if (kind === 0) {
      const s = snapState;
      s.origin[0] = e[0];
      s.origin[1] = e[1];
      s.origin[2] = e[2];
      s.velocity[0] = e[1] * 3.3;
      s.velocity[1] = -e[0] * 1.7;
      s.velocity[2] = e[2] * 0.1;
      s.viewYaw = i * 7;
      s.viewPitch = ((i * 13) % 32401) - 16200 + 0x10000;
      s.flags = i;
      s.groundEntity = (i & 1) === 0 ? -1 : 32767;
      s.waterLevel = i;
      s.stamina = i & 4095;
      quantizePlayerState(s);
      const self = (i >> 2) & (CODEC_PLAYERS - 1);
      const tick = i + 1;
      // Each player's slot gets this tick's stamp; the receiver's (and one other) a new state.
      for (let p = 0; p < CODEC_PLAYERS; p++) snapFrame.setPresent(p, tick);
      playerStateToSlot(snapFrame, self, s);
      playerStateToSlot(snapFrame, (self + 5) & (CODEC_PLAYERS - 1), s);
      snapFrame.teleportSeq[self] = i & 0xff;
      snapHeader.serverTick = tick;
      snapHeader.inputBufferHealth = (i & 15) - 8;
      snapHeader.cvarHash = i & 0xffff;
      snapHeader.flags = i & 1;
      encodeSnapshot(w, snapHeader, snapFrame, null, self);
    } else if (kind === 1) {
      inputSent.packetSeq = i & 0xffff;
      inputSent.lastSnapshotTick = i;
      inputSent.count = 1 + ((i >> 2) & 3);
      for (let k = 0; k < 4; k++) {
        const c = inputSent.cmds[k] as UserCmd;
        c.tick = i + 8 - k;
        c.buttons = (i + k) & 0xfff;
        c.forward = (((i + k) & 255) % 255) - 127;
        c.right = (i & 127) - 64;
        c.up = k;
        c.yaw = (i * 97) & 0xffff;
        c.pitch = (((i * 31) % 32401) - 16200) & 0xffff;
        c.weaponSlot = k;
      }
      encodeInput(w, inputSent);
    } else if (kind === 2) {
      pingSent.pingId = i & 0xffff;
      encodePing(w, pingSent);
    } else {
      pongSent.pingId = i & 0xffff;
      pongSent.serverTick = i;
      encodePong(w, pongSent);
    }
    r.reset(w.bytes, w.byteLength);
    const type = peekMessageType(w.bytes, w.byteLength);
    if (type === MSG_SNAPSHOT) {
      const self = (i >> 2) & (CODEC_PLAYERS - 1);
      if (
        decodeSnapshotHeader(r, snapGotHeader) &&
        decodeSnapshotBody(r, snapGotHeader, null, self, snapGotFrame)
      ) {
        slotToPlayerState(snapGotFrame, self, snapGotState);
        if (playerStateEquals(snapGotState, snapState)) outcomes[0] = (outcomes[0] as number) + 1;
      }
    } else if (type === MSG_INPUT) {
      if (decodeInput(r, inputGot) && inputGot.count === inputSent.count) {
        outcomes[1] = (outcomes[1] as number) + 1;
      }
    } else if (type === MSG_PING) {
      if (decodePing(r, pingGot) && pingGot.pingId === pingSent.pingId) {
        outcomes[2] = (outcomes[2] as number) + 1;
      }
    } else if (type === MSG_PONG) {
      if (decodePong(r, pongGot) && pongGot.serverTick === pongSent.serverTick) {
        outcomes[2] = (outcomes[2] as number) + 1;
      }
    }
    const h = hostile[i & (HOSTILE_COUNT - 1)] as Uint8Array;
    r.reset(h, h.length);
    const hType = h[0] as number;
    const accepted =
      hType === MSG_INPUT
        ? decodeInput(r, inputGot)
        : hType === MSG_SNAPSHOT
          ? decodeSnapshotHeader(r, snapGotHeader) &&
            decodeSnapshotBody(r, snapGotHeader, null, 3, snapGotFrame)
          : decodePong(r, pongGot);
    if (!accepted) codecRejected[0] = (codecRejected[0] as number) + 1;
  }
}

// Delta snapshots (D-038): a 16-player world the server captures each tick into its 64-frame
// history, each tick's snapshot a delta for one receiver against a baseline 1–63 ticks back (full
// every 16th tick), decoded by the client's SnapshotStore against its own ring. Every 61st
// snapshot is lost on the way, so deltas against it take the store's missing-baseline drop. Then
// one hostile delta per call, decoded against a fixed baseline, which must be refused.
const DC_PLAYERS = 16;
const DC_SELF = 3;
const dcHistory = new FrameRing();
const dcStore = new SnapshotStore();
const dcHeader = new SnapshotHeader();
const dcReader = new BitReader();
let dcTick = 0;
let dcSerial = 1;

/** The server's frame of tick `t`: tick t − 1's players moved on (integer steps), events, a rejoin. */
function dcCapture(t: number): WorldFrame {
  const f = dcHistory.slot(t);
  const prevFrame = dcHistory.get(t - 1);
  f.clear();
  for (let p = 0; p < DC_PLAYERS; p++) {
    if (prevFrame !== null && prevFrame.present[p] === 1) copySlot(f, p, prevFrame, p);
    else {
      f.setPresent(p, t);
      f.serial[p] = dcSerial;
      f.teleportSeq[p] = (f.teleportSeq[p] as number) + 1;
    }
    f.setPresent(p, t);
    // Runners: x creeps every tick, y now and then, velocity with it; yaw turns.
    f.originX[p] = (((f.originX[p] as number) + 37 + p) & 0x3ffff) - 0x20000;
    if (((t + p) & 3) === 0) f.originY[p] = (f.originY[p] as number) + ((t & 8) === 0 ? 70 : -70);
    f.vel16X[p] = ((t * 13 + p * 101) & 0x1fff) - 0x1000;
    f.entVelX[p] = entityVelocity(f.vel16X[p] as number);
    f.yaw[p] = (t * 91 + p * 4099) & 0xffff;
  }
  // Player 15 leaves for 32 ticks of every 256 and comes back as a new incarnation.
  if ((t & 255) < 32) f.setAbsent(DC_PLAYERS - 1);
  else if ((t & 255) === 32) {
    dcSerial = (dcSerial + 1) & 0xffff;
    f.serial[DC_PLAYERS - 1] = dcSerial;
    f.teleportSeq[DC_PLAYERS - 1] = ((f.teleportSeq[DC_PLAYERS - 1] as number) + 1) & 0xff;
  }
  if ((t & 15) === 0) {
    const s = (t >> 4) & 7;
    pushEntityEvent(f.eventSeq, f.evKind, f.evValue, s, PMEV_STEP, t & 0x7f);
  }
  dcHistory.store(t);
  return f;
}

/** A hostile delta's header (tick 1000, 10 back) and no local change; `count` records follow. */
function dcHostileStart(w: BitWriter, count: number): void {
  w.reset();
  w.writeBits(MSG_SNAPSHOT, 8);
  w.writeBits(1000, 16);
  w.writeBits(0, 16);
  w.writeBits(10, 6);
  w.writeBits(0, 16);
  w.writeBits(0, 16);
  w.writeBits(0, 8);
  // The delta local block's mask: no local change.
  w.writeBits(0, 8);
  w.writeBits(count, 7);
}

/** A delta record's id, removed bit 0, new bit 0 and mask. */
function dcRecord(w: BitWriter, id: number, mask: number): void {
  w.writeBits(id, 16);
  w.writeBits(0, 2);
  w.writeBits(mask, 8);
}

/** The baseline of the hostile deltas: the receiver and players 3, 20 and 40, every field 0. */
const dcHostileBase = new WorldFrame();
const dcHostileOut = new WorldFrame();
const DC_HOSTILE_SELF = 9;
dcHostileBase.setPresent(DC_HOSTILE_SELF, 990);
for (const id of [3, 20, 40]) dcHostileBase.setPresent(id, 990);
const dcHostile: Uint8Array[] = [];
{
  const w = new BitWriter(MAX_UNRELIABLE_BYTES);
  const done = () => dcHostile.push(w.bytes.slice(0, w.byteLength));
  // A mask of 0.
  dcHostileStart(w, 1);
  dcRecord(w, 3, 0);
  done();
  // An origin axis of class 1 that differs by 0 (non-minimal).
  dcHostileStart(w, 1);
  dcRecord(w, 3, 1);
  w.writeBits(1, 2);
  w.writeBits(0, 7);
  w.writeBits(0, 4);
  done();
  // A yaw equal to the baseline's.
  dcHostileStart(w, 1);
  dcRecord(w, 20, 4);
  w.writeBits(0, 16);
  done();
  // A delta for a slot the baseline lacks.
  dcHostileStart(w, 1);
  dcRecord(w, 50, 4);
  w.writeBits(5, 16);
  done();
  // A removal of a slot the baseline lacks.
  dcHostileStart(w, 1);
  w.writeBits(50, 16);
  w.writeBits(1, 1);
  done();
  // Ids out of order (both removals are otherwise fine).
  dcHostileStart(w, 2);
  w.writeBits(20, 16);
  w.writeBits(1, 1);
  w.writeBits(3, 16);
  w.writeBits(1, 1);
  done();
  // An absolute entity velocity of −32768.
  dcHostileStart(w, 1);
  dcRecord(w, 40, 2);
  w.writeBits(3, 2);
  w.writeBits(0x8000, 16);
  w.writeBits(0, 4);
  done();
  // Event kind 4, after two good records.
  dcHostileStart(w, 3);
  dcRecord(w, 3, 4);
  w.writeBits(1, 16);
  dcRecord(w, 20, 4);
  w.writeBits(1, 16);
  dcRecord(w, 40, 128);
  w.writeBits(1, 8);
  w.writeBits(4, 4);
  w.writeBits(0, 20);
  done();
}
// Each hostile delta's valid twin (the defect removed) must decode, or a layout slip would make
// every hostile packet fail early, on misaligned bits, and leave the refusals it names unrun.
{
  const w = new BitWriter(MAX_UNRELIABLE_BYTES);
  const r = new BitReader();
  const h = new SnapshotHeader();
  const check = (what: string) => {
    r.reset(w.bytes, w.byteLength);
    if (
      !decodeSnapshotHeader(r, h) ||
      !decodeSnapshotBody(r, h, dcHostileBase, DC_HOSTILE_SELF, dcHostileOut)
    ) {
      throw new Error(`deltaCodec: the valid twin of the hostile '${what}' delta is refused`);
    }
  };
  dcHostileStart(w, 0);
  check("empty");
  dcHostileStart(w, 1);
  dcRecord(w, 3, 1);
  w.writeBits(1, 2);
  w.writeBits(1, 7);
  w.writeBits(0, 4);
  check("class 1 axis");
  dcHostileStart(w, 1);
  dcRecord(w, 20, 4);
  w.writeBits(5, 16);
  check("yaw");
  dcHostileStart(w, 1);
  w.writeBits(3, 16);
  w.writeBits(1, 1);
  check("removal");
  dcHostileStart(w, 2);
  w.writeBits(3, 16);
  w.writeBits(1, 1);
  w.writeBits(20, 16);
  w.writeBits(1, 1);
  check("ids in order");
  dcHostileStart(w, 1);
  dcRecord(w, 40, 2);
  w.writeBits(3, 2);
  w.writeBits(0x7fff, 16);
  w.writeBits(0, 4);
  check("velocity");
  dcHostileStart(w, 3);
  dcRecord(w, 3, 4);
  w.writeBits(1, 16);
  dcRecord(w, 20, 4);
  w.writeBits(1, 16);
  dcRecord(w, 40, 128);
  w.writeBits(1, 8);
  w.writeBits(1, 4);
  w.writeBits(0, 20);
  check("events");
}

/**
 * Whether the client's frame `got` holds what the server's `cur` does as DC_SELF sees it (what
 * frameDigest hashes, compared field by field: a digest's uint32 would box here).
 */
function dcSame(got: WorldFrame, cur: WorldFrame): boolean {
  for (let s = 0; s < FRAME_SLOTS; s++) {
    if (got.present[s] !== cur.present[s] || got.stamp[s] !== cur.stamp[s]) return false;
    if (cur.present[s] !== 1) continue;
    if (s !== DC_SELF) {
      if (!entityEquals(got, s, cur, s)) return false;
    } else if (
      got.originX[s] !== cur.originX[s] ||
      got.originY[s] !== cur.originY[s] ||
      got.originZ[s] !== cur.originZ[s] ||
      got.vel16X[s] !== cur.vel16X[s] ||
      got.vel16Y[s] !== cur.vel16Y[s] ||
      got.vel16Z[s] !== cur.vel16Z[s] ||
      got.yaw[s] !== cur.yaw[s] ||
      got.pitch[s] !== cur.pitch[s] ||
      got.flags[s] !== cur.flags[s] ||
      got.teleportSeq[s] !== cur.teleportSeq[s]
    ) {
      return false;
    }
  }
  return true;
}

/**
 * A snapshot every fourth call (a 16-player delta costs some 50 times a hostile refusal), one
 * hostile delta every call. Outcomes: stored snapshots equal to the server's frame as the receiver
 * sees it, deltas stored,
 * baseline drops; `extra[0]` full snapshots stored; `codecRejected` counts the hostile refusals.
 */
function runDeltaCodec(n: number): void {
  const w = codecWriter;
  const r = dcReader;
  const h = dcHeader;
  for (let i = 0; i < n; i++) {
    const bad = dcHostile[i & 7] as Uint8Array;
    r.reset(bad, bad.length);
    if (
      !decodeSnapshotHeader(r, h) ||
      !decodeSnapshotBody(r, h, dcHostileBase, DC_HOSTILE_SELF, dcHostileOut)
    ) {
      codecRejected[0] = (codecRejected[0] as number) + 1;
    }
    if ((i & 3) !== 0) continue;
    const t = ++dcTick;
    const cur = dcCapture(t);
    // A rotating baseline age, as long as the store holds that frame (the server codes against
    // acked frames), else the store's ack; a lost tick stays a baseline now and then, so the
    // store's missing-baseline drop runs too. Full every 16th tick and while the history is short:
    // rarer, the full path stays in V8's unoptimized tiers, which box its fractional doubles (a few
    // hundred bytes per full snapshot, measured at every 128th; the codec workload covers that
    // path hot).
    let back = 1 + ((i * 7) % 63);
    if (back < t && !dcStore.ring.has(t - back) && (t - back) % 61 !== 0) {
      const ack = dcStore.ackTick;
      back = ack > 0 && t - ack <= 63 ? t - ack : 0;
    }
    const full = (t & 15) === 0 || back === 0 || back >= t;
    h.serverTick = t;
    h.baseBack = full ? 0 : back;
    h.flags = 0;
    h.cvarHash = t & 0xffff;
    h.inputBufferHealth = (i & 7) - 2;
    w.reset();
    const sent = encodeSnapshot(w, h, cur, full ? null : dcHistory.get(t - back), DC_SELF);
    if (sent && t % 61 !== 0) {
      r.reset(w.bytes, w.byteLength);
      const result = dcStore.receive(r, DC_SELF);
      if (result === STORE_STORED) {
        if (dcSame(dcStore.lastStored as WorldFrame, cur))
          outcomes[0] = (outcomes[0] as number) + 1;
        if (dcStore.header.baseBack !== 0) outcomes[1] = (outcomes[1] as number) + 1;
        else extra[0] = (extra[0] as number) + 1;
      } else if (result === STORE_NO_BASELINE) {
        outcomes[2] = (outcomes[2] as number) + 1;
      }
    }
  }
}

// Transports (D-026, D-028): an idle PortTransport, a raw loopback pair, and one whose client end
// is wrapped by NetSim on the worst profile, on a fractional fake clock (a 144 Hz frame per call),
// so loss, duplication, reordering, jitter and reliable ordering all run, with a wake callback and
// a host that pumps between polls. The callbacks are made once, here.
const [rawClient, rawServer] = createLoopbackPair();
const [simInner, simServer] = createLoopbackPair();
const fakeNow = new Float64Array(1);
const badProfile = findNetProfile("bad-250-loss5") as NetProfile;
const wakeAt = new Float64Array(1);
const sim = new NetSimTransport(
  simInner,
  badProfile,
  () => fakeNow[0] as number,
  0x5eed,
  (at) => {
    wakeAt[0] = at;
  },
);
const upPacket = new Uint8Array(55);
const downPacket = new Uint8Array(42);
const reliablePacket = new Uint8Array(300);
rawServer.onMessage((_d, len) => {
  outcomes[0] = (outcomes[0] as number) + (len & 1);
});
rawClient.onMessage((_d, len) => {
  outcomes[0] = (outcomes[0] as number) + (len & 1);
});
simServer.onMessage((_d, _len, reliable) => {
  if (reliable) outcomes[2] = (outcomes[2] as number) + 1;
  else outcomes[1] = (outcomes[1] as number) + 1;
});
sim.onMessage((_d, _len, reliable) => {
  if (reliable) outcomes[2] = (outcomes[2] as number) + 1;
  else outcomes[1] = (outcomes[1] as number) + 1;
});

// The Worker's PortTransport polls once per frame and per tick whether or not anything arrived;
// a packet allocates by design (the transferred buffer and its view), an empty poll must not.
const idlePort: PortLike = { postMessage: () => {}, onmessage: null };
const portTransport = new PortTransport(idlePort, { postMessage: () => {}, onmessage: null });

function runTransport(n: number): void {
  for (let i = 0; i < n; i++) {
    portTransport.poll();
    fakeNow[0] = (fakeNow[0] as number) + 1000 / 144;
    rawClient.sendUnreliable(upPacket, 55);
    rawServer.sendUnreliable(downPacket, 41 + (i & 1));
    if ((i & 63) === 0) rawServer.sendReliable(reliablePacket, 300);
    rawServer.poll();
    rawClient.poll();
    if ((i & 1) === 0) sim.sendUnreliable(upPacket, 55);
    if ((i & 3) === 0) simServer.sendUnreliable(downPacket, 42);
    if ((i & 63) === 0) {
      sim.sendReliable(reliablePacket, 300);
      simServer.sendReliable(reliablePacket, 300);
    }
    if ((i & 7) === 3) sim.pump();
    sim.poll();
    simServer.poll();
  }
}

// The match tick (D-027): a real Match on movement_lab and one client over a loopback pair, past
// HELLO and READY at setup, plus a bystander that only joined (so every snapshot carries an entity
// record and the world frame two players, D-033). Each call sends an INPUT with four redundant cmds
// (a strafing circle with jumps and attack), skips six in 64 so the starved repeat runs past the
// redundancy, pings now and then, runs one match tick and decodes what came back. A tick is far
// heavier than the calls above, so a run is n / 10 ticks, after a longer warm-up.
class MatchRig {
  readonly match: Match;
  readonly client: LoopbackEndpoint;
  readonly bystander: LoopbackEndpoint;
  readonly writer = new BitWriter(MAX_RELIABLE_BYTES);
  readonly reader = new BitReader();
  readonly input = new InputMsg();
  readonly snapHeader = new SnapshotHeader();
  readonly snapFrame = new WorldFrame();
  readonly pong = new PongMsg();
  readonly ping = new PingMsg();
  /** Warm-up calls left: the first runs eight times as long (see runMatch). */
  warmup = 1;

  constructor() {
    const course = loadCourse("movement_lab");
    this.match = new Match({ cmap: course.cmap, world: course.world, buildHash: "alloc" });
    const [client, server] = createLoopbackPair();
    this.client = client;
    this.match.connect(server, true);
    client.onMessage((d, len) => this.receive(d, len));
    const [bystander, bystanderServer] = createLoopbackPair();
    this.bystander = bystander;
    this.match.connect(bystanderServer);
    bystander.onMessage(() => {});
    const hello = new HelloMsg();
    hello.buildHash = "alloc";
    this.writer.reset();
    encodeHello(this.writer, hello);
    client.sendReliable(this.writer.bytes, this.writer.byteLength);
    bystander.sendReliable(this.writer.bytes, this.writer.byteLength);
    this.match.tick();
    client.poll();
    this.writer.reset();
    encodeReady(this.writer);
    client.sendReliable(this.writer.bytes, this.writer.byteLength);
    bystander.sendReliable(this.writer.bytes, this.writer.byteLength);
    this.match.tick();
    client.poll();
  }

  private receive(d: Uint8Array, len: number): void {
    this.reader.reset(d, len);
    const type = peekMessageType(d, len);
    const h = this.snapHeader;
    if (
      type === MSG_SNAPSHOT &&
      decodeSnapshotHeader(this.reader, h) &&
      decodeSnapshotBody(this.reader, h, null, 0, this.snapFrame) &&
      this.snapFrame.present[1] === 1
    ) {
      outcomes[0] = (outcomes[0] as number) + 1;
      if ((h.flags & SNAP_FLAG_STARVED) !== 0) outcomes[1] = (outcomes[1] as number) + 1;
    } else if (type === MSG_PONG && decodePong(this.reader, this.pong)) {
      outcomes[2] = (outcomes[2] as number) + 1;
    }
  }
}

/** Built on the first match call only, so the other workloads' counters never see it. */
let matchRig: MatchRig | null = null;

function fillMatchCmd(c: UserCmd, tick: number): void {
  c.tick = tick;
  c.buttons = (tick % 50 < 2 ? BUTTON_JUMP : 0) | (tick % 3 === 0 ? BUTTON_ATTACK : 0);
  c.forward = 127;
  c.right = 127;
  c.up = 0;
  c.yaw = (tick * 300) & 0xffff;
  c.pitch = 0;
  c.weaponSlot = 0;
}

function runMatch(n: number): void {
  if (matchRig === null) matchRig = new MatchRig();
  const rig = matchRig;
  const match = rig.match;
  const client = rig.client;
  const w = rig.writer;
  const input = rig.input;
  // V8 keeps compiling a path this deep for about 150000 ticks; its heap use then settles to 0.
  const ticks = rig.warmup-- > 0 ? (n / 10) * 8 : n / 10;
  for (let i = 0; i < ticks; i++) {
    const newest = match.serverTick + 3;
    if ((i & 63) < 58) {
      input.packetSeq = i & 0xffff;
      input.lastSnapshotTick = match.serverTick;
      input.count = 4;
      for (let k = 0; k < 4; k++) fillMatchCmd(input.cmds[k] as UserCmd, newest - k);
      w.reset();
      encodeInput(w, input);
      client.sendUnreliable(w.bytes, w.byteLength);
    }
    if (i % 30 === 0) {
      rig.ping.pingId = i & 0xffff;
      w.reset();
      encodePing(w, rig.ping);
      client.sendUnreliable(w.bytes, w.byteLength);
    }
    match.tick();
    client.poll();
    rig.bystander.poll();
  }
}

// Prediction and reconciliation (M2 design §5, D-027/D-028): the real ClientSim on a fractional
// fake clock, 144 Hz frames, against a real Match over a loopback pair, with the strafe-jump
// circuit bot and a second player that only joined (so the snapshot store decodes an entity
// record every snapshot, D-033). The link is impaired so every client path runs:
// - every 256 server ticks the client's next six INPUT packets are dropped, so the server starves
//   past the 4× redundancy and the client corrects (snapshots compared, states adopted, ticks
//   re-simulated, corrections logged and moved into the render offset);
// - every 1200 ticks the INPUTs' delay switches between 0 and 10 ticks (a pooled ring), so the
//   buffer health leaves its band and the clock fast-forwards and holds;
// - every 2048 ticks the client skips its frames for 8 ticks, a hitch longer than the lead, so a
//   backlog of snapshots overtakes the prediction and it hard-resyncs and re-anchors;
// - every 4096 ticks, for 1024 ticks, the client runs a frame only every 5th server tick (83 ms,
//   a slow host), so the buffer health saw-tooths: the low edge's window, its dip count and the
//   adaptive lead run, and the clock fast-forwards on the dips (and holds after the phase);
// - every 4096 ticks the server respawns the client's player (Match.respawn, since M3 increment
//   5), so a snapshot with a new teleport counter takes the predictor's SNAPSHOT_TELEPORT path and
//   the client drops its render offset (D-035).
// A run is n / 10 server ticks (and 2.4 frames per tick), after a warm-up 12 times as long: V8
// keeps optimizing this path for some 250000 ticks before its heap use settles to 0.

const DELAY_SLOTS = 64;

/** The client's end: drops `dropLeft` INPUTs when told to, and delays INPUTs by `delay` ticks. */
class ImpairedTransport implements Transport {
  dropLeft = 0;
  /** INPUT delay in server ticks, and the server's newest tick (set by the rig). */
  delay = 0;
  tick = 0;
  private readonly slots: Uint8Array[] = [];
  private readonly lens = new Int32Array(DELAY_SLOTS);
  private readonly due = new Int32Array(DELAY_SLOTS);
  private head = 0;
  private count = 0;
  constructor(private readonly inner: LoopbackEndpoint) {
    for (let i = 0; i < DELAY_SLOTS; i++) this.slots.push(new Uint8Array(MAX_UNRELIABLE_BYTES));
  }
  sendUnreliable(d: Uint8Array, len: number): void {
    if (d[0] !== MSG_INPUT) {
      this.inner.sendUnreliable(d, len);
    } else if (this.dropLeft > 0) {
      this.dropLeft--;
    } else if ((this.delay === 0 && this.count === 0) || this.count === DELAY_SLOTS) {
      this.inner.sendUnreliable(d, len);
    } else {
      const i = (this.head + this.count) & (DELAY_SLOTS - 1);
      const slot = this.slots[i] as Uint8Array;
      for (let b = 0; b < len; b++) slot[b] = d[b] as number;
      this.lens[i] = len;
      this.due[i] = this.tick + this.delay;
      this.count++;
    }
  }
  /** Sends the delayed INPUTs due by the server's tick `tick`. */
  release(tick: number): void {
    while (this.count > 0 && (this.due[this.head] as number) <= tick) {
      this.inner.sendUnreliable(
        this.slots[this.head] as Uint8Array,
        this.lens[this.head] as number,
      );
      this.head = (this.head + 1) & (DELAY_SLOTS - 1);
      this.count--;
    }
  }
  sendReliable(d: Uint8Array, len: number): void {
    this.inner.sendReliable(d, len);
  }
  onMessage(cb: MessageHandler): void {
    this.inner.onMessage(cb);
  }
  onClose(cb: CloseHandler): void {
    this.inner.onClose(cb);
  }
  poll(): void {
    this.inner.poll();
  }
  close(reason?: string): void {
    this.inner.close(reason);
  }
  isOpen(): boolean {
    return this.inner.isOpen();
  }
  stats(): TransportStats {
    return this.inner.stats();
  }
}

class PredictRig {
  readonly match: Match;
  readonly client: ClientSim;
  readonly transport: ImpairedTransport;
  /** The client's session, respawned every 4096 ticks. */
  readonly session: Session;
  /** A second player that only joined, so the client's snapshots carry an entity record. */
  readonly bystander: LoopbackEndpoint;
  /** [0] fake now (ms), [1] server tick accumulator (ms). */
  readonly time = new Float64Array(2);
  readonly out = vec3();
  warmup = 1;
  /** Client frames are skipped until this server tick (a hitch). */
  pausedUntil = 0;
  /** Until this server tick the client runs a frame only every 5th tick (a slow host). */
  slowUntil = 0;
  lastFrameTick = -1;
  /** Clock steps taken during the slow phases. */
  slowSteps = 0;

  constructor() {
    const course = loadCourse("movement_lab");
    this.match = new Match({ cmap: course.cmap, world: course.world, buildHash: "alloc" });
    const [clientEnd, serverEnd] = createLoopbackPair();
    const session = this.match.connect(serverEnd, true);
    if (session === null) throw new Error("predict: the match refused the client");
    this.session = session;
    this.transport = new ImpairedTransport(clientEnd);
    const [bystander, bystanderServer] = createLoopbackPair();
    this.bystander = bystander;
    this.match.connect(bystanderServer);
    bystander.onMessage(() => {});
    const w = new BitWriter(MAX_RELIABLE_BYTES);
    const hello = new HelloMsg();
    hello.buildHash = "alloc";
    encodeHello(w, hello);
    bystander.sendReliable(w.bytes, w.byteLength);
    w.reset();
    encodeReady(w);
    bystander.sendReliable(w.bytes, w.byteLength);
    const time = this.time;
    this.client = new ClientSim({
      transport: this.transport,
      cmap: course.cmap,
      world: course.world,
      buildHash: "alloc",
      clock: () => time[0] as number,
      input: new StrafeCircuit(),
    });
    this.client.connect();
  }
}

let predictRig: PredictRig | null = null;
const FRAME_MS = 1000 / 144;
const SERVER_TICK_MS = 1000 / 60;

function runPredict(n: number): void {
  if (predictRig === null) predictRig = new PredictRig();
  const rig = predictRig;
  const time = rig.time;
  const client = rig.client;
  const match = rig.match;
  const link = rig.transport;
  const totals = client.stats.totals;
  const ticks = rig.warmup-- > 0 ? (n / 10) * 12 : n / 10;
  const end = match.serverTick + ticks;
  while (match.serverTick < end) {
    time[0] = (time[0] as number) + FRAME_MS;
    time[1] = (time[1] as number) + FRAME_MS;
    while ((time[1] as number) >= SERVER_TICK_MS) {
      time[1] = (time[1] as number) - SERVER_TICK_MS;
      link.release(match.serverTick + 1);
      match.tick();
      rig.bystander.poll();
      const t = match.serverTick;
      link.tick = t;
      if ((t & 255) === 0) link.dropLeft = 6;
      if (t % 1200 === 0) link.delay = link.delay === 0 ? 10 : 0;
      if ((t & 2047) === 1024) rig.pausedUntil = t + 8;
      if ((t & 4095) === 2048) rig.slowUntil = t + 1024;
      if ((t & 4095) === 512) match.respawn(rig.session);
    }
    if (match.serverTick < rig.pausedUntil) continue;
    const slow = match.serverTick < rig.slowUntil;
    if (slow && (match.serverTick % 5 !== 0 || match.serverTick === rig.lastFrameTick)) continue;
    rig.lastFrameTick = match.serverTick;
    const steps = client.clock.adjustments;
    client.frame();
    if (slow) rig.slowSteps += client.clock.adjustments - steps;
    client.renderOrigin(rig.out);
  }
  outcomes[0] = totals[STAT_CORRECTIONS] as number;
  outcomes[1] = Math.min(totals[STAT_CLOCK_ADJUSTMENTS] as number, rig.slowSteps);
  outcomes[2] = totals[STAT_HARD_RESYNCS] as number;
  extra[0] = totals[STAT_TELEPORTS] as number;
}

// The Node server's per-tick wrapper (D-029): TimedPass over two matches, both histograms and the
// 1 s windows it closes every 60 passes. Small-integer clocks stand in for performance.now and
// process.cpuUsage, whose boxed results are the host's own cost, not the pass's.
let passClockMs = 0;
const passClock: PassClock = {
  now: () => {
    passClockMs += 3;
    return passClockMs;
  },
  cpuMicros: () => passClockMs >> 1,
};
const idleMatch = { tick: () => {} } as unknown as Match;
const timedMatches: ServerMatch[] = [
  { name: "a", match: idleMatch, ticks: new TickHistogram(), traffic: new WireTraffic() },
  { name: "b", match: idleMatch, ticks: new TickHistogram(), traffic: new WireTraffic() },
];
const timedPass = new TimedPass(timedMatches, () => {}, passClock);
timedPass.loopStats = new LoopStats();

function runTimedPass(n: number): void {
  for (let i = 0; i < n; i++) timedPass.tick();
  outcomes[0] = timedPass.passes;
  outcomes[1] = (timedMatches[0] as ServerMatch).ticks.lastP99Us;
  outcomes[2] = timedPass.ticks.lastMaxUs;
}

// The server end of a WebSocket per packet (D-030): arrivals copied into the pooled inbox (both
// channels, the zero-length marker for an oversized unreliable message, drop-oldest past 256),
// then a poll per 320 arrivals, which also reads the socket's buffered amount. Sends allocate one
// Buffer each by design (D-030's boundary allocation) and are left out.
const wsSocket: WsSocket = { bufferedAmount: 0, send: () => {}, close: () => {} };
const wsTransport = new WsTransport(wsSocket, new WsLimits());
// Counted as the server counts a match's sockets (D-036): payload plus framing per arrival.
wsTransport.traffic = new WireTraffic();
const wsCounts = new Int32Array(2);
wsTransport.onMessage((_d, len, reliable) => {
  if (reliable) wsCounts[0] = (wsCounts[0] as number) + 1;
  else if (len === 0) wsCounts[1] = (wsCounts[1] as number) + 1;
});
const wsReliable = Buffer.alloc(40);
wsReliable[0] = MSG_CMD;
const wsUnreliable = Buffer.alloc(55);
wsUnreliable[0] = MSG_INPUT;
const wsOversized = Buffer.alloc(MAX_UNRELIABLE_BYTES + 100);
wsOversized[0] = MSG_INPUT;

// The client end (D-030), in the same child: arrivals past the boundary (`receiveBytes`; the
// browser's ArrayBuffer, event and view over it are the boundary's allocation) on both channels,
// the zero-length marker and drop-oldest, a poll per 320; and the sends a session makes from its
// one writer: INPUT every tick and, between them, a PING (another length) every 60.
const wsClientSocket: SocketLike = {
  binaryType: "arraybuffer",
  readyState: 1,
  send: () => {},
  close: () => {},
  onopen: null,
  onmessage: null,
  onclose: null,
  onerror: null,
};
const wsClient = new WebSocketTransport(wsClientSocket);
wsClient.onMessage((_d, len, reliable) => {
  if (reliable) extra[0] = (extra[0] as number) + 1;
  else if (len === 0) extra[1] = (extra[1] as number) + 1;
});
const wsClientReliable = new Uint8Array(40);
wsClientReliable[0] = MSG_CMD;
const wsClientUnreliable = new Uint8Array(300);
wsClientUnreliable[0] = MSG_SNAPSHOT;
const wsClientOversized = new Uint8Array(MAX_UNRELIABLE_BYTES + 100);
wsClientOversized[0] = MSG_SNAPSHOT;
const wsClientWriter = new Uint8Array(MAX_UNRELIABLE_BYTES);
wsClientWriter[0] = MSG_INPUT;

function runWsTransport(n: number): void {
  for (let i = 0; i < n; i++) {
    const k = i % 320;
    if ((k & 15) === 0) wsTransport.receive(wsReliable, true);
    else if (k % 50 === 7) wsTransport.receive(wsOversized, true);
    else wsTransport.receive(wsUnreliable, true);
    if (k === 319) wsTransport.poll();

    if ((k & 15) === 0) wsClient.receiveBytes(wsClientReliable);
    else if (k % 50 === 7) wsClient.receiveBytes(wsClientOversized);
    else wsClient.receiveBytes(wsClientUnreliable);
    if (k === 319) wsClient.poll();
    wsClient.sendUnreliable(wsClientWriter, i % 60 === 30 ? 13 : 55);
  }
  outcomes[0] = wsCounts[0] as number;
  outcomes[1] = wsCounts[1] as number;
  outcomes[2] = wsTransport.stats().lost;
  extra[2] = wsClient.stats().lost;
  extra[3] = wsClient.stats().sent;
}

// The remote interpolation per frame (D-037): 16 remotes in a client snapshot store, filled as the
// store would hold them (every tick at 60 Hz, frames at 144 Hz on a fractional fake clock), moving
// at up to 600 u/s across the walled room (the slope and the rotated box clamp the extrapolation
// traces), crouching, with movement events, a teleport-counter step every 64 ticks (one remote
// in turn), one remote removed for 30 ticks every 300 and back, and every 512 ticks a 12-tick
// snapshot outage, so slots extrapolate, hold and rejoin with an offset; the NET-05 meter runs
// on every frame. The auto delay sizes itself from the arrivals.
class InterpRig {
  readonly now = new Float64Array(2);
  readonly store = new SnapshotStore();
  readonly settings = new ClientNetSettings();
  readonly stats = new NetStats(this.now);
  readonly interp: RemoteInterpolator;
  readonly meter = new RemoteJumpMeter();
  tick = 0;

  constructor() {
    this.interp = new RemoteInterpolator(this.store, this.now, this.settings, this.stats, world);
  }

  /** Stores tick `t`'s frame: the receiver (slot 0) and 16 remotes (slots 3, 6, …, 48). */
  store1(t: number): void {
    const ring = this.store.ring;
    const f = ring.slot(t);
    f.clear();
    f.setPresent(0, t);
    for (let k = 1; k <= 16; k++) {
      const s = k * 3;
      if (k === 16 && t % 300 < 30) continue;
      f.setPresent(s, t);
      // Back and forth along x over 768 u at 300–600 u/s, one row of y per remote.
      const period = 80 + 5 * k;
      const phase = t % (2 * period);
      const dir = phase < period ? 1 : -1;
      const along = phase < period ? phase : 2 * period - phase;
      f.originX[s] = (-384 + (along * 768) / period) * 32;
      f.originY[s] = (-480 + 60 * k) * 32;
      f.originZ[s] = 24 * 32 + ((t + k) & 3) * 16;
      f.entVelX[s] = (dir * 768 * 60) / period;
      f.entVelY[s] = 0;
      f.entVelZ[s] = 0;
      f.yaw[s] = (t * 300 + k * 4000) & 0xffff;
      f.pitch[s] = ((t + k) % 200) - 100;
      f.flags[s] = PMF_GROUNDED | (((t >> 5) + k) % 3 === 0 ? PMF_CROUCHED : 0);
      f.team[s] = 1 + (k & 1);
      f.teleportSeq[s] = ((t >> 10) + (k === ((t >> 6) & 15) + 1 ? 1 : 0)) & 0xff;
      if ((t + k) % 7 === 0) pushEntityEvent(eventSeqs, evKinds, evValues, s, PMEV_LAND, t & 0xff);
      f.eventSeq[s] = eventSeqs[s] as number;
      f.evKind[s * 2] = evKinds[s * 2] as number;
      f.evKind[s * 2 + 1] = evKinds[s * 2 + 1] as number;
      f.evValue[s * 2] = evValues[s * 2] as number;
      f.evValue[s * 2 + 1] = evValues[s * 2 + 1] as number;
    }
    ring.store(t);
    this.store.newestTick = t;
    this.interp.onStored(t);
  }
}

const eventSeqs = new Uint8Array(64);
const evKinds = new Uint8Array(128);
const evValues = new Uint8Array(128);
let interpRig: InterpRig | null = null;

function runInterp(n: number): void {
  if (interpRig === null) interpRig = new InterpRig();
  const rig = interpRig;
  const now = rig.now;
  for (let i = 0; i < n; i++) {
    now[0] = (now[0] as number) + 1000 / 144;
    now[1] = (now[1] as number) + 1000 / 144;
    while ((now[1] as number) >= 1000 / 60) {
      now[1] = (now[1] as number) - 1000 / 60;
      const t = ++rig.tick;
      if ((t & 511) >= 12) rig.store1(t);
    }
    rig.stats.advance();
    rig.interp.update(0);
    rig.meter.measure(rig.interp, true);
  }
  const totals = rig.stats.totals;
  outcomes[0] = (totals[STAT_REMOTE_EXTRAPOLATED] as number) + (totals[STAT_REMOTE_HELD] as number);
  outcomes[1] = totals[STAT_REMOTE_EVENTS] as number;
  outcomes[2] = rig.meter.t[JM_CHECKED] as number;
  extra[0] = totals[STAT_REMOTE_HELD] as number;
}

const WORKLOADS: Record<string, (n: number) => void> = {
  botInput: runBotInput,
  codec: runCodec,
  deltaCodec: runDeltaCodec,
  interp: runInterp,
  match: runMatch,
  pmove: runPmove,
  pmoveModes: runPmoveModes,
  pmoveBasics: runPmoveBasics,
  predict: runPredict,
  quantize: runQuantize,
  scenario: runScenario,
  snap: runSnap,
  strafeBot: runStrafeBot,
  state: runState,
  timedPass: runTimedPass,
  trace: runTrace,
  transport: runTransport,
  wsTransport: runWsTransport,
};
const workload = process.argv[2];
const run = workload === undefined ? undefined : WORKLOADS[workload];
if (run === undefined) throw new Error(`unknown workload ${String(workload)}`);

let gcs = 0;
const observer = new PerformanceObserver((list) => {
  gcs += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
run(CALLS);
const attempts: string[] = [];
let clean = false;
// As in trace-allocation.test.ts: a stray GC can land in one attempt, per-call garbage in all.
for (let attempt = 0; attempt < 3 && !clean; attempt++) {
  await settle();
  gcs = 0;
  const before = process.memoryUsage().heapUsed;
  run(CALLS);
  const growth = process.memoryUsage().heapUsed - before;
  await settle();
  attempts.push(`${gcs} GCs, heap ${growth >= 0 ? "+" : ""}${growth} B`);
  clean = gcs === 0 && growth < 64 * 1024;
}
observer.disconnect();
console.log(
  JSON.stringify({
    clean,
    attempts,
    outcomes: Array.from(outcomes),
    extra: Array.from(extra),
    rejected: codecRejected[0],
  }),
);
