import { PerformanceObserver } from "node:perf_hooks";
import { ClientSim, type CmdSampler, SnapshotStore, STORE_STORED } from "@game/client/net";
import { Match, type Session } from "@game/server";
import {
  BitReader,
  BitWriter,
  BUTTON_CROUCH,
  BUTTON_JUMP,
  BUTTON_WALK,
  createLoopbackPair,
  encodeHello,
  encodeInput,
  encodeReady,
  HelloMsg,
  InputMsg,
  type LoopbackEndpoint,
  MAX_RELIABLE_BYTES,
  MOVE_AXIS_MAX,
  MSG_SNAPSHOT,
  type PlayerState,
  PMF_ON_LADDER,
  peekMessageType,
  pmovePrimed,
  TRACE_EPSILON,
  type UserCmd,
} from "@game/shared";
import { courseAnchor, loadCourse } from "../../src/scenarios/course";

// Child process of long/pmove-primer.long.ts (`pnpm test:long`, D-040, M3 design §2.11): the
// pmove primer's guard. The transient the primer removes happens once per process (docs/10 §4.4:
// a pmove branch first reached after V8 optimized its function deoptimizes it, and a move V8 has
// not yet optimized boxes its doubles), so unlike nativeEsmAllocation.ts this child has no
// warm-up of the measured input and no retry: a flat phase on movement_lab's open floor, then a
// flat window (the harness's own steady state), exactly one first-stairs window and one
// first-ladder window, 2e4 ticks each, each measured for GCs and heap growth. A full collection
// before each window (`--expose-gc`) empties the young generation, so what a window allocates
// stays in the heap to be counted. Run as native ESM (`node --import tsx`), where V8 boxes the
// doubles a deoptimized tick touches. Prints one JSON line.
//
// argv: `server` (a real Match and a raw loopback client decoding into the client's
// SnapshotStore: the server's pmove) or `client` (the real ClientSim at 144 Hz, its prediction
// and replays, against a Match built with the primer off, so only ClientSim's hook primes); then
// `on`, or `off` for the primer-off control (both hooks off).

const WINDOW_TICKS = 20_000;

const mode = process.argv[2];
const primer = process.argv[3] === "on";
if ((mode !== "server" && mode !== "client") || (!primer && process.argv[3] !== "off")) {
  throw new Error("usage: primerAllocation.ts server|client on|off");
}

/**
 * The flat phase: the design's 1.6e5 player-ticks for the server; the client's prediction path
 * (2.4 frames a tick, corrections, replays) needs the predict workload's 2.4e5 before its heap
 * use settles to 0.
 */
const FLAT_TICKS = mode === "server" ? 160_000 : 240_000;

const course = loadCourse("movement_lab");
const stairs = courseAnchor(course, "stairs_base").origin;
const ladder = courseAnchor(course, "ladder_base").origin;
const spawn = course.cmap.entities.find((e) => e.classname === "info_player_start")?.origin;
if (spawn === undefined) throw new Error("movement_lab has no info_player_start");

const PH_FLAT = 0;
const PH_STAIRS = 1;
const PH_LADDER = 2;

// The phases as tables, so the harness runs the same code in every phase: a branch of its own
// first taken in a window would deoptimize it there and count against the primer. Each phase
// teleports once at its start and then moves on its own (a teleport is a correction and a replay
// on the client, a rarely run path that boxes a few hundred bytes each time), steering along a
// waypoint loop or by its segment table.
// - Flat (2048-tick cycles of eight 256-tick segments, back to the spawn 64 u up at the start of
//   each): a strafing circle with jumps; the circle with a pitch sweep; straight east with jumps;
//   straight west; jumping in place; a crouched circle the other way; a walked circle; a circle
//   with long jump holds. Turning and not, pitch moving and not, crouched, walking and still, so
//   the snapshot codec's field branches have seen both outcomes before the windows. It never
//   meets a wall, a step or a ladder.
// - Stairs: a loop from stairs_base north up the stairs, over the landing and off its north
//   edge, then round the east side of the flight back to the base.
// - Ladder: a loop from ladder_base north up the ladder, over the top and off the block's north
//   side, then round its east side back to the ladder; a jump every 240 ticks, a jump-off when
//   it falls on the ladder.
const SEGMENTS = 8;
const CYCLE = 2048;
/** Ticks between teleports (each phase also teleports at its start). */
const TELEPORT_EVERY = Int32Array.of(CYCLE, 1 << 30, 1 << 30);

/** One segment's input. Jump is down while t % jumpCycle < jumpLen. */
interface Segment {
  /** 1: yaw toward the next waypoint; 0: yawBase + tick · yawRate. */
  steer: number;
  forward: number;
  right: number;
  yawBase: number;
  yawRate: number;
  /** 1: pitch sweeps ±8000 u16; 0: level. */
  pitchSweep: number;
  held: number;
  jumpCycle: number;
  jumpLen: number;
}

function row(o: Partial<Segment>): Segment {
  return {
    steer: 0,
    forward: 1,
    right: 0,
    yawBase: 0,
    yawRate: 0,
    pitchSweep: 0,
    held: 0,
    jumpCycle: 50,
    jumpLen: 0,
    ...o,
  };
}

const STAIRS_SEGMENT = row({ steer: 1, jumpCycle: 240 });
const LADDER_SEGMENT = row({ steer: 1, jumpCycle: 240, jumpLen: 1 });
const ROWS: Segment[] = [
  row({ right: 1, yawRate: 300, jumpLen: 2 }),
  row({ right: 1, yawRate: 300, pitchSweep: 1 }),
  row({ jumpLen: 2 }),
  row({ yawBase: 32768 }),
  row({ forward: 0, yawBase: 8192, pitchSweep: 1, jumpLen: 2 }),
  row({ right: -1, yawRate: -300, held: BUTTON_CROUCH, jumpLen: 2 }),
  row({ right: 1, yawRate: 300, held: BUTTON_WALK, jumpLen: 2 }),
  row({ right: -1, yawRate: -300, jumpLen: 20 }),
  ...Array.from({ length: SEGMENTS }, () => STAIRS_SEGMENT),
  ...Array.from({ length: SEGMENTS }, () => LADDER_SEGMENT),
];

/** A field of every row (phase × SEGMENTS + segment), as the per-tick code reads it. */
function column(field: keyof Segment): Int32Array {
  return Int32Array.from(ROWS, (r) => r[field]);
}

const STEER = column("steer");
const FORWARD = column("forward");
const RIGHT = column("right");
const YAW_BASE = column("yawBase");
const YAW_RATE = column("yawRate");
const PITCH_SWEEP = column("pitchSweep");
const HELD = column("held");
const JUMP_CYCLE = column("jumpCycle");
const JUMP_LEN = column("jumpLen");
/** Where each phase starts (x, y, z of the origin). */
const AT = Float64Array.from([
  ...[spawn[0], spawn[1], spawn[2] + 64],
  ...[stairs[0], stairs[1], stairs[2] + TRACE_EPSILON],
  ...[ladder[0], ladder[1], ladder[2] + TRACE_EPSILON],
]);
/**
 * Each phase's waypoint loop (x, y; WAYPOINTS per phase). The flat phase steers by its table, but
 * its loop is followed in the same code (a square round the spawn), so the advance runs there too.
 */
const WAYPOINTS = 5;
const [px, py] = spawn;
const sx = stairs[0];
const lx = ladder[0];
const LOOPS: readonly (readonly [number, number])[] = [
  // Flat: the spawn (reached at once after each teleport), then a square round it.
  [px, py],
  [px - 256, py - 256],
  [px + 256, py - 256],
  [px + 256, py + 256],
  [px - 256, py + 256],
  // Stairs: the flight runs north from y 3584 to its landing's edge at 4032, 192 u wide.
  [sx, 4160],
  [sx + 256, 4160],
  [sx + 256, 3420],
  [sx, 3420],
  [sx, stairs[1]],
  // Ladder: the block spans x ±128 and y 3712–3840, 384 u high, the ladder on its south face.
  [lx, 4000],
  [lx + 300, 4000],
  [lx + 300, 3600],
  [lx, 3600],
  [lx, ladder[1]],
];
const WP = Float64Array.from(LOOPS.flat());
/** A waypoint counts as reached within this distance (u). */
const WP_REACHED = 32;
const U16_PER_RADIAN = 32768 / Math.PI;

/** The scripted input of the current phase; `t` is the phase's tick, `wp` its next waypoint. */
class Script {
  phase = PH_FLAT;
  t = 0;
  wp = 0;
  fill(c: UserCmd, tick: number, ps: Readonly<PlayerState>): void {
    const p = this.phase;
    const k = p * SEGMENTS + ((((this.t % CYCLE) * SEGMENTS) / CYCLE) | 0);
    const w = 2 * (p * WAYPOINTS + this.wp);
    const dx = (WP[w] as number) - ps.origin[0];
    const dy = (WP[w + 1] as number) - ps.origin[1];
    if (dx * dx + dy * dy < WP_REACHED * WP_REACHED) this.wp = (this.wp + 1) % WAYPOINTS;
    const steer = STEER[k] as number;
    const toward = Math.round(Math.atan2(dy, dx) * U16_PER_RADIAN) | 0;
    const table = (YAW_BASE[k] as number) + tick * (YAW_RATE[k] as number);
    c.tick = tick;
    c.up = 0;
    c.weaponSlot = 0;
    c.forward = MOVE_AXIS_MAX * (FORWARD[k] as number);
    c.right = MOVE_AXIS_MAX * (RIGHT[k] as number);
    c.yaw = (steer * toward + (1 - steer) * table) & 0xffff;
    // As a u16, as cmds carry it (which also turns a zero sweep's −0, a double, into 0).
    c.pitch = ((PITCH_SWEEP[k] as number) * (((tick * 97) % 16000) - 8000)) & 0xffff;
    const j = this.t % (JUMP_CYCLE[k] as number);
    c.buttons = (HELD[k] as number) | (j < (JUMP_LEN[k] as number) ? BUTTON_JUMP : 0);
  }
  teleportNow(): boolean {
    return this.t % (TELEPORT_EVERY[this.phase] as number) === 0;
  }
}

const script = new Script();

function place(ps: PlayerState): void {
  const o = 3 * script.phase;
  ps.origin[0] = AT[o] as number;
  ps.origin[1] = AT[o + 1] as number;
  ps.origin[2] = AT[o + 2] as number;
  ps.velocity[0] = 0;
  ps.velocity[1] = 0;
  ps.velocity[2] = 0;
  script.wp = 0;
}

/** One server tick of the chosen rig, after the script has advanced. */
interface Rig {
  tick(): void;
  readonly match: Match;
  readonly session: Session;
}

/** The server's side: a real Match and one raw client (four redundant cmds an INPUT). */
class ServerRig implements Rig {
  readonly match: Match;
  readonly client: LoopbackEndpoint;
  readonly session: Session;
  readonly writer = new BitWriter(MAX_RELIABLE_BYTES);
  readonly reader = new BitReader();
  readonly input = new InputMsg();
  readonly store = new SnapshotStore();
  stored = 0;

  constructor() {
    this.match = new Match({
      cmap: course.cmap,
      world: course.world,
      buildHash: "alloc",
      primer,
    });
    const [client, server] = createLoopbackPair();
    this.client = client;
    const s = this.match.connect(server, true);
    if (s === null) throw new Error("the match refused the client");
    this.session = s;
    client.onMessage((d, len) => {
      if (peekMessageType(d, len) !== MSG_SNAPSHOT) return;
      this.reader.reset(d, len);
      if (this.store.receive(this.reader, 0) === STORE_STORED) this.stored++;
    });
    const hello = new HelloMsg();
    hello.buildHash = "alloc";
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

  tick(): void {
    const match = this.match;
    const newest = match.serverTick + 3;
    const input = this.input;
    input.packetSeq = newest & 0xffff;
    input.lastSnapshotTick = this.store.ackTick;
    input.count = 4;
    const ps = this.session.player;
    for (let k = 0; k < 4; k++) script.fill(input.cmds[k] as UserCmd, newest - k, ps);
    const w = this.writer;
    w.reset();
    encodeInput(w, input);
    this.client.sendUnreliable(w.bytes, w.byteLength);
    match.tick();
    this.client.poll();
  }
}

class ScriptSampler implements CmdSampler {
  sample(cmd: UserCmd, ps: Readonly<PlayerState>): void {
    script.fill(cmd, cmd.tick, ps);
  }
}

const FRAME_MS = 1000 / 144;
const SERVER_TICK_MS = 1000 / 60;

/** The client's side: the real ClientSim at 144 Hz on a fake clock against a Match. */
class ClientRig implements Rig {
  readonly match: Match;
  readonly client: ClientSim;
  readonly session: Session;
  /** [0] fake now (ms), [1] server tick accumulator (ms). */
  readonly time = new Float64Array(2);

  constructor() {
    const time = this.time;
    const [clientEnd, serverEnd] = createLoopbackPair();
    // The client primes first (or not, in the control); the match never does.
    this.client = new ClientSim({
      transport: clientEnd,
      cmap: course.cmap,
      world: course.world,
      buildHash: "alloc",
      clock: () => time[0] as number,
      input: new ScriptSampler(),
      primer,
    });
    this.match = new Match({
      cmap: course.cmap,
      world: course.world,
      buildHash: "alloc",
      primer: false,
    });
    const s = this.match.connect(serverEnd, true);
    if (s === null) throw new Error("the match refused the client");
    this.session = s;
    this.client.connect();
  }

  tick(): void {
    const time = this.time;
    const end = this.match.serverTick + 1;
    while (this.match.serverTick < end) {
      time[0] = (time[0] as number) + FRAME_MS;
      time[1] = (time[1] as number) + FRAME_MS;
      while ((time[1] as number) >= SERVER_TICK_MS) {
        time[1] = (time[1] as number) - SERVER_TICK_MS;
        this.match.tick();
      }
      this.client.frame();
    }
  }
}

const rig: Rig = mode === "server" ? new ServerRig() : new ClientRig();
const primedAtStart = pmovePrimed();

/** Per phase: ticks on the ladder, rises of 8 u or more in a tick (stair steps), the peak z. */
const ladderTicks = new Int32Array(3);
const climbs = new Int32Array(3);
const peakZ = new Int32Array(3);

/**
 * One tick of a phase. Its own function, called every tick, so V8 optimizes it early: the loop
 * that calls it starts each window in the interpreter, which boxes every double it touches. The
 * counters' conditions only pick constants, and z is taken as an integer.
 */
function phaseTick(phase: number, ps: PlayerState): void {
  if (script.teleportNow()) place(ps);
  const before = ps.origin[2] | 0;
  rig.tick();
  const z = ps.origin[2] | 0;
  ladderTicks[phase] = (ladderTicks[phase] as number) + ((ps.flags & PMF_ON_LADDER) !== 0 ? 1 : 0);
  climbs[phase] = (climbs[phase] as number) + (z - before >= 8 ? 1 : 0);
  peakZ[phase] = Math.max(peakZ[phase] as number, z);
}

function runPhase(phase: number, ticks: number): void {
  script.phase = phase;
  const ps = rig.session.player;
  for (let i = 0; i < ticks; i++) {
    script.t = i;
    phaseTick(phase, ps);
  }
}

let gcs = 0;
const observer = new PerformanceObserver((list) => {
  gcs += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const collect = (globalThis as { gc?: () => void }).gc;
if (collect === undefined) throw new Error("run with --expose-gc");
runPhase(PH_FLAT, FLAT_TICKS);
const windows: { gcs: number; growth: number }[] = [];
for (const phase of [PH_FLAT, PH_STAIRS, PH_LADDER]) {
  // A full collection first, so the window starts with an empty young generation and what it
  // allocates stays countable.
  collect();
  await settle();
  gcs = 0;
  const before = process.memoryUsage().heapUsed;
  runPhase(phase, WINDOW_TICKS);
  const growth = process.memoryUsage().heapUsed - before;
  await settle();
  windows.push({ gcs, growth });
}
observer.disconnect();
console.log(
  JSON.stringify({
    mode,
    primer,
    primed: primedAtStart,
    windows,
    ladderTicks: Array.from(ladderTicks),
    climbs: Array.from(climbs),
    peakZ: Array.from(peakZ),
  }),
);
