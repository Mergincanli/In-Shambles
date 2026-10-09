import { PerformanceObserver, performance } from "node:perf_hooks";
import {
  acceptAck,
  buildSnapshot,
  type ClientMirror,
  MirrorPool,
  resetScheduleState,
  type SnapshotClient,
  SnapshotScheduler,
  WorldHistory,
} from "@game/server";
import {
  BitWriter,
  CvarRegistry,
  copySlot,
  cvarHash16,
  FRAME_SLOTS,
  MAX_UNRELIABLE_BYTES,
  type PlayerState,
  PMEV_STEP,
  PMF_GROUNDED,
  playerStateToSlot,
  pushEntityEvent,
  registerPmoveCvars,
  registryCvarHash,
  SNAPSHOT_HISTORY,
  SnapshotHeader,
  WorldFrame,
} from "@game/shared";
import { buildPmoveWorkload, PMOVE_PLAYERS, PmoveBenchState, runPmoveTicks } from "./pmove.bench";
import { countIn, WARMUP_ROUNDS, warmupCalls } from "./trace.bench";

/**
 * The snapshot build microbenchmark (docs/10 §4.4: ≤ 50 µs per client at 16 players; M3 design
 * §5, estimate ≤ 10 µs): what the match does per client and tick once the world frame is captured
 * (M3 design §2.3, §2.5 step 7; D-038, D-046): the INPUT's ack checked against the client's sent
 * ring and the shared 64-tick history (`acceptAck`), then `buildSnapshot`: the baseline, the
 * byte-budget scheduler's worst-case check (which always passes at 16 players), the encode as a
 * delta against the frame the client holds for that tick, the tick recorded as sent and the
 * scheduler's rows committed, with the server's own functions (`@game/server`). The world is the
 * pmove bench's 16 players on movement_lab after its first 10 s, BUILD_FRAMES consecutive ticks
 * of them captured once before the clock runs, replayed into the history one tick at a time (the
 * capture, once per tick, is shared out over the 16 clients in the figure); each client acks the
 * snapshot 6 + (client + tick) % 5 ticks back, an RTT of acks.
 *
 * A second case, reported only (M3 design §5 "Bench"): a full 64-player match at its worst, every
 * other player changing every entity field at its absolute class two ticks in three (a small step
 * the third), slot 63 leaving for 8 ticks of every 128 and coming back as a new incarnation; 64
 * clients with their mirrors, acking as above, so the size pass and the scheduler run for most
 * snapshots and leave players out of many.
 */

/** Ticks of the 16 players captured before the clock runs, replayed in a loop. */
export const BUILD_FRAMES = 512;
/** The acks' age: 6–10 ticks (design: a 6–10 tick baseline age). */
const ACK_BACK_MIN = 6;
const ACK_BACK_SPAN = 5;
/** The first tick replayed (any tick past the history's length). */
const FIRST_TICK = 1000;

/** docs/10 §4.4: snapshot build per client ≤ 50 µs at 16 players. */
export const BUILD_BUDGET_NS = 50_000;
/** M3 design §4: the estimate, ≤ 10 µs per client at 16 players (reported). */
export const BUILD_ESTIMATE_NS = 10_000;

export interface BuildWorkload {
  /** BUILD_FRAMES world frames, every player present (stamps set when replayed). */
  readonly frames: readonly WorldFrame[];
  readonly cvarHash16: number;
}

export function buildSnapshotBuildWorkload(): BuildWorkload {
  const pmove = buildPmoveWorkload();
  const sim = new PmoveBenchState(pmove);
  runPmoveTicks(pmove, sim, 600);
  const reg = new CvarRegistry();
  registerPmoveCvars(reg);
  const frames: WorldFrame[] = [];
  for (let t = 0; t < BUILD_FRAMES; t++) {
    runPmoveTicks(pmove, sim, 1);
    const f = new WorldFrame();
    for (let p = 0; p < PMOVE_PLAYERS; p++) {
      f.setPresent(p, 1);
      playerStateToSlot(f, p, sim.players[p] as PlayerState);
      f.serial[p] = 1;
      f.team[p] = 1 + (p & 1);
      f.teleportSeq[p] = 1;
    }
    frames.push(f);
  }
  return { frames, cvarHash16: cvarHash16(registryCvarHash(reg)) };
}

/** A client as the match keeps it for its snapshots (`Session`'s `SnapshotClient` part). */
class BuildClient implements SnapshotClient {
  readonly sentTicks = new Int32Array(SNAPSHOT_HISTORY);
  newestSent = 0;
  ackTick = 0;
  readonly lastSent = new Int32Array(FRAME_SLOTS);
  readonly lastDeferred = new Int32Array(FRAME_SLOTS);
  readonly sentSerial = new Int32Array(FRAME_SLOTS);
  mirror: ClientMirror | null = null;
  /** Its player left the world: the next snapshot starts a new session. */
  away = false;
  constructor() {
    resetScheduleState(this);
  }

  reset(): void {
    this.sentTicks.fill(0);
    this.newestSent = 0;
    this.ackTick = 0;
    this.away = false;
    resetScheduleState(this);
    this.mirror?.reset();
  }
}

/** One run's history, the clients' sent state, the scheduler, the writer and counters. */
export class BuildBenchState {
  readonly history = new WorldHistory();
  readonly clients: BuildClient[] = [];
  readonly scheduler = new SnapshotScheduler();
  readonly pool = new MirrorPool();
  readonly writer = new BitWriter(MAX_UNRELIABLE_BYTES);
  readonly header = new SnapshotHeader();
  tick = FIRST_TICK;
  /** Snapshots that failed to encode (expect 0), deltas among those sent, bytes sent. */
  failures = 0;
  snapshots = 0;
  deltas = 0;
  bytes = 0;
  /** The scheduler's work (D-046): size passes, snapshots that left players out, players left out. */
  sizePasses = 0;
  deferredSnapshots = 0;
  deferred = 0;
  /** The largest staleness of a remote at send, and the largest snapshot (B). */
  maxStaleness = 0;
  maxBytes = 0;

  /** `players` clients (slots 0…players − 1); each gets a mirror when the match is above 37. */
  constructor(readonly players = PMOVE_PLAYERS) {
    for (let c = 0; c < players; c++) {
      const client = new BuildClient();
      if (players > 37) client.mirror = this.pool.acquire();
      this.clients.push(client);
    }
  }

  /** Every client's snapshot of `t` (captured), each acking 6–10 ticks back. */
  buildAll(t: number, cvarHash: number): void {
    const history = this.history;
    const sched = this.scheduler;
    const w = this.writer;
    const h = this.header;
    const n = this.players;
    const cur = history.frameFor(t);
    for (let c = 0; c < n; c++) {
      const client = this.clients[c] as BuildClient;
      // A player away gets no snapshot; back, it is a new session (fresh rows, a full snapshot).
      if (cur.present[c] !== 1) {
        client.away = true;
        continue;
      }
      if (client.away) client.reset();
      acceptAck(client, client.newestSent - ACK_BACK_MIN - ((c + t) % ACK_BACK_SPAN), t, history);
      h.flags = 0;
      h.cvarHash = cvarHash;
      h.inputBufferHealth = 2;
      const ok = buildSnapshot(sched, w, h, history, client, c, t, this.pool);
      if (sched.sizePass) this.sizePasses++;
      if (!ok) {
        this.failures++;
        continue;
      }
      this.snapshots++;
      if (h.baseBack !== 0) this.deltas++;
      this.bytes += w.byteLength;
      if (w.byteLength > this.maxBytes) this.maxBytes = w.byteLength;
      const left = sched.deferred + sched.dropped;
      if (left > 0) {
        this.deferredSnapshots++;
        this.deferred += left;
      }
      if (sched.maxStaleness > this.maxStaleness) this.maxStaleness = sched.maxStaleness;
    }
  }

  /** Zeroes the counters (after the untimed first ticks). */
  resetCounters(): void {
    this.snapshots = 0;
    this.deltas = 0;
    this.bytes = 0;
    this.sizePasses = 0;
    this.deferredSnapshots = 0;
    this.deferred = 0;
    this.maxStaleness = 0;
    this.maxBytes = 0;
  }
}

/** `ticks` server ticks: each captures its frame, then builds the snapshot of all 16 clients. */
export function runSnapshotBuild(workload: BuildWorkload, s: BuildBenchState, ticks: number): void {
  const history = s.history;
  const frames = workload.frames;
  for (let i = 0; i < ticks; i++) {
    const t = s.tick++;
    const src = frames[t % BUILD_FRAMES] as WorldFrame;
    const cur = history.frameFor(t);
    cur.clear();
    for (let p = 0; p < PMOVE_PLAYERS; p++) {
      copySlot(cur, p, src, p);
      cur.setPresent(p, t);
    }
    history.stored(t);
    s.buildAll(t, workload.cvarHash16);
  }
}

/** Players of the 64-player case (D-046): a full match. */
export const BUILD_PLAYERS_64 = FRAME_SLOTS;

/**
 * The 64-player case's world (`live`, kept across ticks): tick `t` captured into the history,
 * every player at its worst two ticks in three, slot 63 away for 8 ticks of every 128.
 */
export class Build64World {
  readonly live = new WorldFrame();
  serial = 1;

  capture(history: WorldHistory, t: number): void {
    const live = this.live;
    const worst = t % 3 !== 0;
    for (let p = 0; p < BUILD_PLAYERS_64; p++) {
      if (live.present[p] !== 1) {
        live.serial[p] = this.serial;
        live.teleportSeq[p] = ((live.teleportSeq[p] as number) + 1) & 0xff;
      }
      live.setPresent(p, t);
      if (worst) {
        const sign = ((t + p) & 1) === 0 ? 1 : -1;
        live.originX[p] = sign * (500000 - p * 8);
        live.originY[p] = -sign * (500000 - p * 8);
        live.originZ[p] = sign * (400000 + (t & 63));
        live.vel16X[p] = sign * (500000 - p);
        live.entVelX[p] = sign * (32000 - p);
        live.entVelY[p] = -sign * (32000 - p);
        live.entVelZ[p] = sign * (30000 + (t & 63));
        live.yaw[p] = (t * 4099 + p) & 0xffff;
        live.pitch[p] = sign * (100 + (t & 255));
        live.flags[p] = sign > 0 ? PMF_GROUNDED : 0;
        live.team[p] = sign > 0 ? 1 : 2;
        live.teleportSeq[p] = ((live.teleportSeq[p] as number) + 1) & 0xff;
        pushEntityEvent(live.eventSeq, live.evKind, live.evValue, p, PMEV_STEP, t & 0x7f);
      } else {
        live.originX[p] = (live.originX[p] as number) + 3;
      }
    }
    if ((t & 127) < 8) live.setAbsent(BUILD_PLAYERS_64 - 1);
    else if ((t & 127) === 8) {
      this.serial = (this.serial + 1) & 0xffff;
      live.serial[BUILD_PLAYERS_64 - 1] = this.serial;
    }
    const f = history.frameFor(t);
    f.clear();
    for (let p = 0; p < BUILD_PLAYERS_64; p++) if (live.present[p] === 1) copySlot(f, p, live, p);
    history.stored(t);
  }
}

/** `ticks` ticks of the 64-player case: each captures its frame, then builds every snapshot. */
export function runSnapshotBuild64(
  world: Build64World,
  s: BuildBenchState,
  ticks: number,
  cvarHash: number,
): void {
  for (let i = 0; i < ticks; i++) {
    const t = s.tick++;
    world.capture(s.history, t);
    s.buildAll(t, cvarHash);
  }
}

export interface BuildBenchResult {
  readonly ticks: number;
  /** Per client and tick, the capture shared out: the docs/10 §4.4 figure. */
  readonly nsPerBuild: number;
  /** Mean snapshot size and the share of deltas in the timed loop. */
  readonly bytes: number;
  readonly deltaShare: number;
  readonly failures: number;
  /** GC events inside the timed loop. */
  readonly gcs: number;
}

export function meetsBuildBudget(nsPerBuild: number): boolean {
  return nsPerBuild <= BUILD_BUDGET_NS;
}

/** What `--strict` fails on: a missed budget, any GC or any failed encode. */
export function buildStrictFailure(result: BuildBenchResult): boolean {
  return !meetsBuildBudget(result.nsPerBuild) || result.gcs > 0 || result.failures > 0;
}

/** Warms up in WARMUP_ROUNDS short rounds (as the other benches), then times `ticks` ticks. */
export async function runSnapshotBuildBench(
  workload: BuildWorkload,
  ticks = 20_000,
  warmup = 5_000,
): Promise<BuildBenchResult> {
  const warm = new BuildBenchState();
  for (let round = 0; round < WARMUP_ROUNDS; round++) {
    runSnapshotBuild(workload, warm, warmupCalls(warmup, round));
  }
  const s = new BuildBenchState();
  const gcTimes: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) gcTimes.push(entry.startTime);
  });
  observer.observe({ entryTypes: ["gc"] });
  let ns = 0n;
  let t0 = 0;
  let t1 = 0;
  try {
    // The first ticks of a fresh state are full snapshots (no ack yet): run them untimed.
    runSnapshotBuild(workload, s, ACK_BACK_MIN + ACK_BACK_SPAN + 1);
    s.resetCounters();
    await new Promise((resolve) => setTimeout(resolve, 50));
    t0 = performance.now();
    const h0 = process.hrtime.bigint();
    runSnapshotBuild(workload, s, ticks);
    ns = process.hrtime.bigint() - h0;
    t1 = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    observer.disconnect();
  }
  const builds = ticks * PMOVE_PLAYERS;
  return {
    ticks,
    nsPerBuild: Number(ns) / builds,
    bytes: s.snapshots === 0 ? 0 : s.bytes / s.snapshots,
    deltaShare: s.snapshots === 0 ? 0 : s.deltas / s.snapshots,
    failures: s.failures,
    gcs: countIn(gcTimes, t0, t1),
  };
}

/** The report `pnpm bench` prints. */
export function formatSnapshotBuildBench(result: BuildBenchResult): string {
  const pass = meetsBuildBudget(result.nsPerBuild);
  return [
    `snapshot build: ${result.ticks} ticks of ${PMOVE_PLAYERS} clients (pmove bench states on movement_lab, acks 6–10 ticks back)`,
    `per client (${result.bytes.toFixed(0)} B, ${(100 * result.deltaShare).toFixed(1)}% deltas): ${result.nsPerBuild.toFixed(1)} ns, budget ${BUILD_BUDGET_NS} ns: ${pass ? "PASS" : "FAIL"} (estimate ${BUILD_ESTIMATE_NS} ns)`,
    `failed encodes: ${result.failures} (expect 0); GCs during the build loop: ${result.gcs} (expect 0)`,
  ].join("\n");
}

export interface Build64Result {
  readonly ticks: number;
  /** Per client and tick, the capture shared out (reported, no budget: NET-09 is 16 bots). */
  readonly nsPerBuild: number;
  readonly bytes: number;
  /** Shares of the snapshots that ran the size pass and that left players out. */
  readonly sizePassShare: number;
  readonly deferredShare: number;
  /** Players left out per snapshot that left any out, and the largest staleness (≤ 2). */
  readonly deferredPerSnapshot: number;
  readonly maxStaleness: number;
  readonly maxBytes: number;
  readonly failures: number;
  readonly gcs: number;
}

/** What `--strict` fails on in the 64-player case: a GC, a failed encode or staleness past 2. */
export function build64StrictFailure(result: Build64Result): boolean {
  return result.gcs > 0 || result.failures > 0 || result.maxStaleness > 2;
}

/** The 64-player case (reported): warms up as the 16-player one, then times `ticks` ticks. */
export async function runSnapshotBuild64Bench(
  cvarHash: number,
  ticks = 2_000,
  warmup = 500,
): Promise<Build64Result> {
  const warm = new BuildBenchState(BUILD_PLAYERS_64);
  const warmWorld = new Build64World();
  for (let round = 0; round < WARMUP_ROUNDS; round++) {
    runSnapshotBuild64(warmWorld, warm, warmupCalls(warmup, round), cvarHash);
  }
  const s = new BuildBenchState(BUILD_PLAYERS_64);
  const world = new Build64World();
  const gcTimes: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) gcTimes.push(entry.startTime);
  });
  observer.observe({ entryTypes: ["gc"] });
  let ns = 0n;
  let t0 = 0;
  let t1 = 0;
  try {
    runSnapshotBuild64(world, s, ACK_BACK_MIN + ACK_BACK_SPAN + 1, cvarHash);
    s.resetCounters();
    await new Promise((resolve) => setTimeout(resolve, 50));
    t0 = performance.now();
    const h0 = process.hrtime.bigint();
    runSnapshotBuild64(world, s, ticks, cvarHash);
    ns = process.hrtime.bigint() - h0;
    t1 = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    observer.disconnect();
  }
  const builds = ticks * BUILD_PLAYERS_64;
  const snaps = s.snapshots;
  return {
    ticks,
    nsPerBuild: Number(ns) / builds,
    bytes: snaps === 0 ? 0 : s.bytes / snaps,
    sizePassShare: snaps === 0 ? 0 : s.sizePasses / snaps,
    deferredShare: snaps === 0 ? 0 : s.deferredSnapshots / snaps,
    deferredPerSnapshot: s.deferredSnapshots === 0 ? 0 : s.deferred / s.deferredSnapshots,
    maxStaleness: s.maxStaleness,
    maxBytes: s.maxBytes,
    failures: s.failures,
    gcs: countIn(gcTimes, t0, t1),
  };
}

/** The 64-player report `pnpm bench` prints. */
export function formatSnapshotBuild64Bench(result: Build64Result): string {
  return [
    `snapshot build, ${BUILD_PLAYERS_64} players at their worst (the byte-budget scheduler, D-046): ${result.ticks} ticks of ${BUILD_PLAYERS_64} clients with mirrors, acks 6–10 ticks back`,
    `per client (${result.bytes.toFixed(0)} B, largest ${result.maxBytes} B): ${result.nsPerBuild.toFixed(1)} ns (reported); ${(100 * result.sizePassShare).toFixed(1)}% size passes, ${(100 * result.deferredShare).toFixed(1)}% leaving players out (${result.deferredPerSnapshot.toFixed(1)} each), max staleness ${result.maxStaleness} (expect ≤ 2)`,
    `failed encodes: ${result.failures} (expect 0); GCs during the build loop: ${result.gcs} (expect 0)`,
  ].join("\n");
}
