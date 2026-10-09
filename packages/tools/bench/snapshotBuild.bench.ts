import { PerformanceObserver, performance } from "node:perf_hooks";
import { acceptAck, baselineTick, markSent, type SentState, WorldHistory } from "@game/server";
import {
  BitWriter,
  CvarRegistry,
  copySlot,
  cvarHash16,
  encodeSnapshot,
  MAX_UNRELIABLE_BYTES,
  type PlayerState,
  playerStateToSlot,
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
 * (M3 design §2.3, §2.5 step 7; D-038): the INPUT's ack checked against the client's sent ring
 * and the shared 64-tick history (`acceptAck`), the baseline chosen (`baselineTick`), the
 * snapshot encoded as a delta against the history's frame of that tick, and the tick recorded as
 * sent, with the server's own functions (`@game/server`, `match/history.ts`). The world is the
 * pmove bench's 16 players on movement_lab after its first 10 s, BUILD_FRAMES consecutive ticks
 * of them captured once before the clock runs, replayed into the history one tick at a time (the
 * capture, once per tick, is shared out over the 16 clients in the figure); each client acks the
 * snapshot 6 + (client + tick) % 5 ticks back, an RTT of acks.
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

/** One run's history, the 16 clients' sent state, the writer and counters. */
export class BuildBenchState {
  readonly history = new WorldHistory();
  readonly clients: SentState[] = [];
  readonly writer = new BitWriter(MAX_UNRELIABLE_BYTES);
  readonly header = new SnapshotHeader();
  tick = FIRST_TICK;
  /** Snapshots that failed to encode (expect 0), deltas among those sent, bytes sent. */
  failures = 0;
  snapshots = 0;
  deltas = 0;
  bytes = 0;

  constructor() {
    for (let c = 0; c < PMOVE_PLAYERS; c++) {
      this.clients.push({ sentTicks: new Int32Array(SNAPSHOT_HISTORY), newestSent: 0, ackTick: 0 });
    }
  }
}

/** `ticks` server ticks: each captures its frame, then builds the snapshot of all 16 clients. */
export function runSnapshotBuild(workload: BuildWorkload, s: BuildBenchState, ticks: number): void {
  const history = s.history;
  const w = s.writer;
  const h = s.header;
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
    for (let c = 0; c < PMOVE_PLAYERS; c++) {
      const client = s.clients[c] as SentState;
      acceptAck(client, client.newestSent - ACK_BACK_MIN - ((c + t) % ACK_BACK_SPAN), t, history);
      const b = baselineTick(client, t, history);
      h.serverTick = t;
      h.baseBack = b === 0 ? 0 : t - b;
      h.flags = 0;
      h.cvarHash = workload.cvarHash16;
      h.inputBufferHealth = 2;
      w.reset();
      if (!encodeSnapshot(w, h, cur, b === 0 ? null : history.get(b), c)) {
        s.failures++;
        continue;
      }
      markSent(client, t);
      s.snapshots++;
      if (b !== 0) s.deltas++;
      s.bytes += w.byteLength;
    }
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
    s.snapshots = 0;
    s.deltas = 0;
    s.bytes = 0;
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
