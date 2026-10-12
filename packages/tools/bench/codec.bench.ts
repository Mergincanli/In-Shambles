import { PerformanceObserver, performance } from "node:perf_hooks";
import {
  BitReader,
  BitWriter,
  CvarRegistry,
  cvarHash16,
  decodeInput,
  decodeSnapshotBody,
  decodeSnapshotHeader,
  encodeInput,
  encodeSnapshot,
  InputMsg,
  MAX_UNRELIABLE_BYTES,
  type PlayerState,
  playerStateToSlot,
  registerPmoveCvars,
  registryCvarHash,
  SnapshotHeader,
  type UserCmd,
  WorldFrame,
} from "@game/shared";
import { buildPmoveWorkload, PMOVE_PLAYERS, PmoveBenchState, runPmoveTicks } from "./pmove.bench";
import { countIn, WARMUP_ROUNDS, warmupCalls } from "./trace.bench";

/**
 * The snapshot codec microbenchmark (docs/10 §4.4: encode + decode of a typical snapshot
 * ≤ 30 µs). Since M3 increment 8 a typical snapshot is a 16-player match's protocol v2 delta
 * (D-033, D-038): the receiver's state as a delta local block and the other 15 players as delta
 * records against the frame of a baseline 6–10 ticks back (about an RTT of acks). The cases are
 * the pmove bench's 16 players on movement_lab (running, jumping, swimming, on the ladder) over 64
 * ticks after BASELINE_BACK_MAX lead-in ticks, one world frame per tick, each tick's snapshot for
 * each of the 16 receivers, captured once before the clock runs, behind a header like the match
 * sends. Decoding goes through the header and the body into a frame against the baseline frame,
 * as the client's store does. INPUT, the other per-tick message, is timed alongside with four
 * cmds from the pmove bench's cmd table. (Until increment 8 the typical snapshot was the full one,
 * 436 B.)
 */

/** Snapshots captured: the pmove bench's 16 players over 64 ticks, one per receiver. */
export const CODEC_CASES = 1024;
const CAPTURE_TICKS = CODEC_CASES / PMOVE_PLAYERS;
/** The cases' baselines: 6 + (case % 5) ticks back (design: a 6–10 tick baseline age). */
export const BASELINE_BACK_MIN = 6;
export const BASELINE_BACK_MAX = 10;

/** docs/10 §4.4: codec encode/decode of a typical snapshot ≤ 30 µs. */
export const CODEC_BUDGET_NS = 30_000;

export interface CodecWorkload {
  /** One world frame per captured tick (the lead-in first), every player present. */
  readonly frames: readonly WorldFrame[];
  /**
   * Per case: its header (`baseBack` set), the frame it is encoded from, its baseline frame's
   * index and its receiver.
   */
  readonly headers: readonly SnapshotHeader[];
  readonly frameOf: Int32Array;
  readonly baseOf: Int32Array;
  readonly receiver: Int32Array;
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
  const frames: WorldFrame[] = [];
  const headers: SnapshotHeader[] = [];
  const frameOf = new Int32Array(CODEC_CASES);
  const baseOf = new Int32Array(CODEC_CASES);
  const receiver = new Int32Array(CODEC_CASES);
  for (let t = 0; t < BASELINE_BACK_MAX + CAPTURE_TICKS; t++) {
    runPmoveTicks(pmove, sim, 1);
    const f = new WorldFrame();
    for (let p = 0; p < PMOVE_PLAYERS; p++) {
      f.setPresent(p, sim.tick);
      playerStateToSlot(f, p, sim.players[p] as PlayerState);
      f.teleportSeq[p] = 1;
    }
    frames.push(f);
    if (t < BASELINE_BACK_MAX) continue;
    for (let p = 0; p < PMOVE_PLAYERS; p++) {
      const c = headers.length;
      const back = BASELINE_BACK_MIN + (c % (BASELINE_BACK_MAX - BASELINE_BACK_MIN + 1));
      const h = new SnapshotHeader();
      h.serverTick = sim.tick;
      h.baseBack = back;
      h.inputBufferHealth = 1 + (p % 3);
      h.cvarHash = hash;
      frameOf[c] = t;
      baseOf[c] = t - back;
      receiver[c] = p;
      headers.push(h);
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
  return { frames, headers, frameOf, baseOf, receiver, inputs };
}

/** One run's writer, reader, decode targets and sinks. */
export class CodecBenchState {
  readonly writer = new BitWriter(MAX_UNRELIABLE_BYTES);
  readonly reader = new BitReader();
  readonly header = new SnapshotHeader();
  readonly frame = new WorldFrame();
  readonly input = new InputMsg();
  /** Messages that failed to encode or decode (expect 0), then bytes sent per kind. */
  failures = 0;
  snapshotBytes = 0;
  inputBytes = 0;
  sink = 0;
}

/**
 * `calls` delta snapshot encodes, each followed by its decode (header, then body against the
 * baseline frame), cycling the cases. The baseline is the server's frame of that tick on both
 * sides: the decoder reads only what the receiver's own frame holds alike.
 */
export function runSnapshotCodec(workload: CodecWorkload, s: CodecBenchState, calls: number): void {
  const w = s.writer;
  const r = s.reader;
  const hdr = s.header;
  const out = s.frame;
  const frames = workload.frames;
  const headers = workload.headers;
  for (let i = 0; i < calls; i++) {
    const c = i & (CODEC_CASES - 1);
    const self = workload.receiver[c] as number;
    const f = frames[workload.frameOf[c] as number] as WorldFrame;
    const base = frames[workload.baseOf[c] as number] as WorldFrame;
    w.reset();
    const sent = encodeSnapshot(w, headers[c] as SnapshotHeader, f, base, self);
    r.reset(w.bytes, w.byteLength);
    if (!sent || !decodeSnapshotHeader(r, hdr) || !decodeSnapshotBody(r, hdr, base, self, out)) {
      s.failures++;
    }
    s.snapshotBytes += w.byteLength;
    s.sink += out.originX[self] as number;
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
    `SNAPSHOT, v2 delta of 16 players (${result.snapshotBytes.toFixed(0)} B) encode+decode: ${result.nsPerSnapshot.toFixed(1)} ns, budget ${CODEC_BUDGET_NS} ns: ${pass ? "PASS" : "FAIL"}`,
    `INPUT, 4 cmds (${result.inputBytes.toFixed(0)} B) encode+decode: ${result.nsPerInput.toFixed(1)} ns`,
    `failed round trips: ${result.failures} (expect 0); GCs during the codec loops: ${result.gcs} (expect 0)`,
    `sink: ${result.sink}`,
  ].join("\n");
}
