import { PerformanceObserver } from "node:perf_hooks";
import {
  ClientSim,
  type PortLike,
  PortTransport,
  type SocketLike,
  STAT_CLOCK_ADJUSTMENTS,
  STAT_CORRECTIONS,
  STAT_HARD_RESYNCS,
  StrafeCircuit,
  WebSocketTransport,
} from "@game/client/net";
import { LoopStats, Match, TickHistogram } from "@game/server";
import {
  type PassClock,
  type ServerMatch,
  TimedPass,
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
  createCollisionWorld,
  createLoopbackPair,
  decodeInput,
  decodePing,
  decodePong,
  decodeSnapshot,
  encodeHello,
  encodeInput,
  encodePing,
  encodePong,
  encodeReady,
  encodeSnapshot,
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
  pmove,
  pointContents,
  positionContents,
  positionTest,
  quantizePlayerState,
  refreshPmoveParams,
  registerPmoveCvars,
  rotatedBoxPlanes,
  SNAP_FLAG_STARVED,
  SnapshotMsg,
  SURF_LADDER,
  sanitizeUserCmd,
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
  wedgePlanes,
} from "@game/shared";
import { HoldInput, HopForward, StrafeHop } from "../../src/scenarios/bots";
import { anchorYawU16, courseAnchor, loadCourse } from "../../src/scenarios/course";
import { placeAtAnchor, ScenarioRecord, ScenarioRunner } from "../../src/scenarios/runner";

// Child process for native-esm-allocation.test.ts: `node --import tsx` loads shared as native ES
// modules, as dev:server and bench do. There V8 boxes doubles that the Vitest module runner and
// the bundle keep unboxed, so the in-process allocation test cannot see it. Prints one JSON line.

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

const codecWriter = new BitWriter(MAX_UNRELIABLE_BYTES);
const codecReader = new BitReader();
const snapSent = new SnapshotMsg();
const snapGot = new SnapshotMsg();
const inputSent = new InputMsg();
const inputGot = new InputMsg();
const pingSent = new PingMsg();
const pingGot = new PingMsg();
const pongSent = new PongMsg();
const pongGot = new PongMsg();

/**
 * Packets the decoders must refuse, as a server sees from a broken or hostile client: random
 * bytes behind an INPUT, SNAPSHOT or PONG type byte, and valid messages with a u32 tick set to
 * 2^32 − 1 (a value that would box if a decoder stored it before checking it). Built once.
 */
const HOSTILE_COUNT = 64;
const hostile: Uint8Array[] = [];
const hostileTypes = [MSG_INPUT, MSG_SNAPSHOT, MSG_PONG];
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
    encodeSnapshot(codecWriter, snapSent);
  } else {
    encodePong(codecWriter, pongSent);
  }
  const bytes = codecWriter.bytes.slice(0, codecWriter.byteLength);
  // INPUT lastSnapshotTick and PONG serverTick at byte 3; SNAPSHOT serverTick at byte 1 or
  // lastProcessedCmdTick at byte 9.
  const at = type === MSG_SNAPSHOT ? ((i & 1) === 0 ? 1 : 9) : 3;
  bytes.fill(0xff, at, at + 4);
  hostile.push(bytes);
}
/** Hostile packets refused (all of them, when the decoders work). */
const codecRejected = new Int32Array(1);

/**
 * The per-tick messages (D-026): SNAPSHOT (a quantized state with fractional origin and velocity),
 * INPUT with 1–4 cmds, PING and PONG, each encoded, dispatched on its type byte and decoded,
 * then one hostile packet, which must be refused without allocating either. Outcomes: snapshots,
 * inputs, pings and pongs that came back equal; `codecRejected` counts the refusals.
 */
function runCodec(n: number): void {
  const w = codecWriter;
  const r = codecReader;
  for (let i = 0; i < n; i++) {
    const e = exact[i & (CASES - 1)] as Vec3;
    const kind = i & 3;
    w.reset();
    if (kind === 0) {
      const s = snapSent.state;
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
      snapSent.serverTick = i;
      snapSent.lastProcessedCmdTick = i;
      snapSent.inputBufferHealth = (i & 15) - 8;
      snapSent.cvarHash = i & 0xffff;
      snapSent.flags = i & 3;
      encodeSnapshot(w, snapSent);
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
      if (decodeSnapshot(r, snapGot) && playerStateEquals(snapGot.state, snapSent.state)) {
        outcomes[0] = (outcomes[0] as number) + 1;
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
          ? decodeSnapshot(r, snapGot)
          : decodePong(r, pongGot);
    if (!accepted) codecRejected[0] = (codecRejected[0] as number) + 1;
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
// HELLO and READY at setup. Each call sends an INPUT with four redundant cmds (a strafing circle
// with jumps and attack), skips six in 64 so the starved repeat runs past the redundancy, pings
// now and then, runs one match tick and decodes what came back. A tick is far heavier than the
// calls above, so a run is n / 10 ticks, after a longer warm-up.
class MatchRig {
  readonly match: Match;
  readonly client: LoopbackEndpoint;
  readonly writer = new BitWriter(MAX_RELIABLE_BYTES);
  readonly reader = new BitReader();
  readonly input = new InputMsg();
  readonly snap = new SnapshotMsg();
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
    const hello = new HelloMsg();
    hello.buildHash = "alloc";
    this.writer.reset();
    encodeHello(this.writer, hello);
    client.sendReliable(this.writer.bytes, this.writer.byteLength);
    this.match.tick();
    client.poll();
    this.writer.reset();
    encodeReady(this.writer);
    client.sendReliable(this.writer.bytes, this.writer.byteLength);
    this.match.tick();
    client.poll();
  }

  private receive(d: Uint8Array, len: number): void {
    this.reader.reset(d, len);
    const type = peekMessageType(d, len);
    if (type === MSG_SNAPSHOT && decodeSnapshot(this.reader, this.snap)) {
      outcomes[0] = (outcomes[0] as number) + 1;
      if ((this.snap.flags & SNAP_FLAG_STARVED) !== 0) outcomes[1] = (outcomes[1] as number) + 1;
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
  }
}

// Prediction and reconciliation (M2 design §5, D-027/D-028): the real ClientSim on a fractional
// fake clock, 144 Hz frames, against a real Match over a loopback pair, with the strafe-jump
// circuit bot. The link is impaired so every client path runs:
// - every 256 server ticks the client's next six INPUT packets are dropped, so the server starves
//   past the 4× redundancy and the client corrects (snapshots compared, states adopted, ticks
//   re-simulated, corrections logged and moved into the render offset);
// - every 1200 ticks the INPUTs' delay switches between 0 and 10 ticks (a pooled ring), so the
//   buffer health leaves its band and the clock fast-forwards and holds;
// - every 2048 ticks the client skips its frames for 8 ticks, a hitch longer than the lead, so a
//   backlog of snapshots overtakes the prediction and it hard-resyncs and re-anchors;
// - every 4096 ticks, for 1024 ticks, the client runs a frame only every 5th server tick (83 ms,
//   a slow host), so the buffer health saw-tooths: the low edge's window, its dip count and the
//   adaptive lead run, and the clock fast-forwards on the dips (and holds after the phase).
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
    this.match.connect(serverEnd, true);
    this.transport = new ImpairedTransport(clientEnd);
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
      const t = match.serverTick;
      link.tick = t;
      if ((t & 255) === 0) link.dropLeft = 6;
      if (t % 1200 === 0) link.delay = link.delay === 0 ? 10 : 0;
      if ((t & 2047) === 1024) rig.pausedUntil = t + 8;
      if ((t & 4095) === 2048) rig.slowUntil = t + 1024;
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
  { name: "a", match: idleMatch, ticks: new TickHistogram() },
  { name: "b", match: idleMatch, ticks: new TickHistogram() },
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

const WORKLOADS: Record<string, (n: number) => void> = {
  codec: runCodec,
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
