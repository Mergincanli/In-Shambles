import { PerformanceObserver, performance } from "node:perf_hooks";
import {
  BitReader,
  BitWriter,
  CvarRegistry,
  copyPlayerState,
  cvarHash16,
  decodeInput,
  decodeSnapshot,
  encodeInput,
  encodeSnapshot,
  InputMsg,
  MAX_UNRELIABLE_BYTES,
  type PlayerState,
  registerPmoveCvars,
  registryCvarHash,
  SnapshotMsg,
  type UserCmd,
} from "@game/shared";
import { buildPmoveWorkload, PMOVE_PLAYERS, PmoveBenchState, runPmoveTicks } from "./pmove.bench";
import { countIn, WARMUP_ROUNDS, warmupCalls } from "./trace.bench";

/**
 * The snapshot codec microbenchmark (docs/10 §4.4: encode + decode of a typical snapshot
 * ≤ 30 µs). A typical M2 snapshot is the full local player state (D-026): the cases are the states
 * of the pmove bench's players on movement_lab (running, jumping, swimming, on the ladder),
 * captured once before the clock runs, behind a header like the match sends. INPUT, the other
 * per-tick message, is timed alongside with four cmds from the pmove bench's cmd table.
 */

/** Snapshots captured: the pmove bench's 16 players over 64 ticks. */
export const CODEC_CASES = 1024;
const CAPTURE_TICKS = CODEC_CASES / PMOVE_PLAYERS;

/** docs/10 §4.4: codec encode/decode of a typical snapshot ≤ 30 µs. */
export const CODEC_BUDGET_NS = 30_000;

export interface CodecWorkload {
  readonly snapshots: readonly SnapshotMsg[];
  readonly inputs: readonly InputMsg[];
}

/** Snapshots and INPUT packets as a 16-player match produces them after its first 10 s. */
export function buildCodecWorkload(): CodecWorkload {
  const pmove = buildPmoveWorkload();
  const sim = new PmoveBenchState(pmove);
  runPmoveTicks(pmove, sim, 600);
  const reg = new CvarRegistry();
  registerPmoveCvars(reg);
  const hash = cvarHash16(registryCvarHash(reg));
  const snapshots: SnapshotMsg[] = [];
  for (let t = 0; t < CAPTURE_TICKS; t++) {
    runPmoveTicks(pmove, sim, 1);
    for (let p = 0; p < PMOVE_PLAYERS; p++) {
      const m = new SnapshotMsg();
      m.serverTick = sim.tick;
      m.lastProcessedCmdTick = sim.tick;
      m.inputBufferHealth = 1 + (p % 3);
      m.cvarHash = hash;
      copyPlayerState(m.state, sim.players[p] as PlayerState);
      snapshots.push(m);
    }
  }
  const inputs: InputMsg[] = [];
  const table = pmove.cmds;
  const ticks = table.length / 5;
  for (let i = 0; i < CODEC_CASES; i++) {
    const m = new InputMsg();
    m.packetSeq = i;
    m.lastSnapshotTick = 600 + i - 3;
    m.count = 4;
    for (let k = 0; k < 4; k++) {
      const c = m.cmds[k] as UserCmd;
      const o = ((i + ticks - k) % ticks) * 5;
      c.tick = 600 + i - k;
      c.forward = table[o] as number;
      c.right = table[o + 1] as number;
      c.buttons = table[o + 2] as number;
      c.yaw = table[o + 3] as number;
      c.pitch = table[o + 4] as number;
      c.weaponSlot = k & 1;
    }
    inputs.push(m);
  }
  return { snapshots, inputs };
}

/** One run's writer, reader, decode targets and sinks. */
export class CodecBenchState {
  readonly writer = new BitWriter(MAX_UNRELIABLE_BYTES);
  readonly reader = new BitReader();
  readonly snapshot = new SnapshotMsg();
  readonly input = new InputMsg();
  /** Messages that failed to encode or decode (expect 0), then bytes sent per kind. */
  failures = 0;
  snapshotBytes = 0;
  inputBytes = 0;
  sink = 0;
}

/** `calls` snapshot encodes, each followed by its decode, cycling the cases. */
export function runSnapshotCodec(workload: CodecWorkload, s: CodecBenchState, calls: number): void {
  const w = s.writer;
  const r = s.reader;
  const out = s.snapshot;
  const cases = workload.snapshots;
  for (let i = 0; i < calls; i++) {
    const m = cases[i & (CODEC_CASES - 1)] as SnapshotMsg;
    w.reset();
    const sent = encodeSnapshot(w, m);
    r.reset(w.bytes, w.byteLength);
    if (!sent || !decodeSnapshot(r, out)) s.failures++;
    s.snapshotBytes += w.byteLength;
    s.sink += out.state.origin[0] as number;
  }
}

/** `calls` INPUT encodes of four cmds, each followed by its decode. */
export function runInputCodec(workload: CodecWorkload, s: CodecBenchState, calls: number): void {
  const w = s.writer;
  const r = s.reader;
  const out = s.input;
  const cases = workload.inputs;
  for (let i = 0; i < calls; i++) {
    const m = cases[i & (CODEC_CASES - 1)] as InputMsg;
    w.reset();
    const sent = encodeInput(w, m);
    r.reset(w.bytes, w.byteLength);
    if (!sent || !decodeInput(r, out)) s.failures++;
    s.inputBytes += w.byteLength;
    s.sink += (out.cmds[3] as UserCmd).yaw;
  }
}

export interface CodecBenchResult {
  readonly calls: number;
  /** Snapshot encode + decode, the docs/10 §4.4 figure. */
  readonly nsPerSnapshot: number;
  readonly nsPerInput: number;
  readonly snapshotBytes: number;
  readonly inputBytes: number;
  readonly failures: number;
  /** GC events inside the timed loops. */
  readonly gcs: number;
  readonly sink: number;
}

export function meetsCodecBudget(nsPerSnapshot: number): boolean {
  return nsPerSnapshot <= CODEC_BUDGET_NS;
}

/** What `--strict` fails on: a missed budget, any GC or any failed round trip. */
export function codecStrictFailure(result: CodecBenchResult): boolean {
  return !meetsCodecBudget(result.nsPerSnapshot) || result.gcs > 0 || result.failures > 0;
}

/** Warms up in WARMUP_ROUNDS short rounds (as the other benches), then times both loops. */
export async function runCodecBench(
  workload: CodecWorkload,
  calls = 1_000_000,
  warmup = 100_000,
): Promise<CodecBenchResult> {
  const warm = new CodecBenchState();
  for (let round = 0; round < WARMUP_ROUNDS; round++) {
    runSnapshotCodec(workload, warm, warmupCalls(warmup, round));
    runInputCodec(workload, warm, warmupCalls(warmup, round));
  }
  const s = new CodecBenchState();
  const gcTimes: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) gcTimes.push(entry.startTime);
  });
  observer.observe({ entryTypes: ["gc"] });
  let snapNs = 0n;
  let inputNs = 0n;
  let t0 = 0;
  let t1 = 0;
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    t0 = performance.now();
    const h0 = process.hrtime.bigint();
    runSnapshotCodec(workload, s, calls);
    const h1 = process.hrtime.bigint();
    runInputCodec(workload, s, calls);
    const h2 = process.hrtime.bigint();
    t1 = performance.now();
    snapNs = h1 - h0;
    inputNs = h2 - h1;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    observer.disconnect();
  }
  return {
    calls,
    nsPerSnapshot: Number(snapNs) / calls,
    nsPerInput: Number(inputNs) / calls,
    snapshotBytes: s.snapshotBytes / calls,
    inputBytes: s.inputBytes / calls,
    failures: s.failures,
    gcs: countIn(gcTimes, t0, t1),
    sink: s.sink,
  };
}

/** The report `pnpm bench` prints. */
export function formatCodecBench(result: CodecBenchResult): string {
  const pass = meetsCodecBudget(result.nsPerSnapshot);
  return [
    `codec: ${result.calls} encode+decode round trips per message, ${CODEC_CASES} cases (pmove bench states on movement_lab)`,
    `SNAPSHOT (${result.snapshotBytes.toFixed(0)} B) encode+decode: ${result.nsPerSnapshot.toFixed(1)} ns, budget ${CODEC_BUDGET_NS} ns: ${pass ? "PASS" : "FAIL"}`,
    `INPUT, 4 cmds (${result.inputBytes.toFixed(0)} B) encode+decode: ${result.nsPerInput.toFixed(1)} ns`,
    `failed round trips: ${result.failures} (expect 0); GCs during the codec loops: ${result.gcs} (expect 0)`,
    `sink: ${result.sink}`,
  ].join("\n");
}
