import { readFileSync } from "node:fs";
import { PerformanceObserver, performance } from "node:perf_hooks";
import {
  ClientNetSettings,
  NetStats,
  RemoteInterpolator,
  SnapshotStore,
  STAT_REMOTE_EXTRAPOLATED,
  STAT_REMOTE_FRAMES,
  STAT_REMOTE_HELD,
} from "@game/client/net";
import {
  buildCollisionWorld,
  type CollisionWorld,
  copySlot,
  decodeCmap,
  FRAME_SLOTS,
  PMEV_LAND,
  PMF_CROUCHED,
  PMF_GROUNDED,
  pushEntityEvent,
} from "@game/shared";
import { fromRoot } from "../src/paths";
import { countIn, WARMUP_ROUNDS, warmupCalls } from "./trace.bench";

/**
 * The remote interpolation frame microbenchmark (M3 design §5 "interp frame", §4's estimate
 * "16-remote interp ≤ 20 µs per frame"; docs/10 §4.4, reported, not a budget): one
 * `RemoteInterpolator.update` of a receiver drawing 16 remotes on arena_greybox at 144 Hz frames
 * over a 60 Hz snapshot stream, the remotes running back and forth at 300–600 u/s with steps,
 * crouches, events and a teleport every 64 ticks. Three cases: a clean stream, one losing 12
 * ticks in every 512 (every remote extrapolated, traced and held, then rejoining), and a full
 * 64-player match (63 remotes, slots 1–63) where the byte-budget scheduler leaves a third of the
 * remotes out of each snapshot, rotating (D-046, since M3 increment 10): their slots hold a copy of
 * the previous frame's state with its older stamp, so the samples are searched by stamp and the
 * defer lag sizes the delay.
 */

/** Remotes drawn in the 16-remote cases (slots 3, 6, …, 48; the receiver is slot 0). */
export const INTERP_REMOTES = 16;
/** Remotes drawn in the 64-player case (slots 1–63). */
export const INTERP_REMOTES_64 = FRAME_SLOTS - 1;
/** M3 design §4's estimate for a 16-remote frame (ESTIMATE, reported). */
export const INTERP_ESTIMATE_NS = 20_000;
const FRAME_MS = 1000 / 144;
const TICK_MS = 1000 / 60;

export function loadArena(): CollisionWorld {
  const bytes = readFileSync(fromRoot("content", "maps", "arena_greybox.cmap"));
  return buildCollisionWorld(decodeCmap(new Uint8Array(bytes)));
}

/** One case's receiver: its store, clock, interpolator and the stream's state. */
export class InterpBenchState {
  readonly now = new Float64Array(2);
  readonly store = new SnapshotStore();
  readonly settings = new ClientNetSettings();
  readonly stats = new NetStats(this.now);
  readonly interp: RemoteInterpolator;
  tick = 0;
  sink = 0;
  private readonly eventSeqs = new Uint8Array(64);
  private readonly evKinds = new Uint8Array(128);
  private readonly evValues = new Uint8Array(128);

  constructor(
    world: CollisionWorld,
    /** Ticks lost in every 512 (0: a clean stream). */
    readonly lostPer512: number,
    /** Remotes drawn: INTERP_REMOTES (slots 3, 6, …) or INTERP_REMOTES_64 (slots 1–63). */
    readonly remotes = INTERP_REMOTES,
    /** A third of the remotes left out of each snapshot, rotating (D-046). */
    readonly deferThird = false,
  ) {
    this.interp = new RemoteInterpolator(this.store, this.now, this.settings, this.stats, world);
  }

  /** Stores tick `t`'s frame as the client's store would. */
  store1(t: number): void {
    const ring = this.store.ring;
    const prev = ring.get(t - 1);
    const f = ring.slot(t);
    f.clear();
    f.setPresent(0, t);
    const stride = this.remotes === INTERP_REMOTES ? 3 : 1;
    for (let k = 1; k <= this.remotes; k++) {
      const s = k * stride;
      // Left out: the client keeps its baseline's state and stamp (here the previous frame's).
      if (this.deferThird && (k + t) % 3 === 0 && prev !== null && prev.present[s] === 1) {
        copySlot(f, s, prev, s);
        continue;
      }
      f.setPresent(s, t);
      const period = 80 + 5 * k;
      const phase = t % (2 * period);
      const dir = phase < period ? 1 : -1;
      const along = phase < period ? phase : 2 * period - phase;
      f.originX[s] = Math.round((-384 + (along * 768) / period) * 32);
      f.originY[s] = Math.round((-480 + (960 * k) / this.remotes) * 32);
      f.originZ[s] = (24 + ((t + k) & 3) * 4) * 32;
      f.entVelX[s] = Math.round((dir * 768 * 60) / period);
      f.entVelY[s] = 0;
      f.entVelZ[s] = 0;
      f.yaw[s] = (t * 300 + k * 4000) & 0xffff;
      f.pitch[s] = ((t + k) % 200) - 100;
      f.flags[s] = PMF_GROUNDED | (((t >> 5) + k) % 3 === 0 ? PMF_CROUCHED : 0);
      f.team[s] = 1 + (k & 1);
      f.teleportSeq[s] = ((t + k * 4) >> 6) & 0xff;
      if ((t + k) % 7 === 0) {
        pushEntityEvent(this.eventSeqs, this.evKinds, this.evValues, s, PMEV_LAND, t & 0xff);
      }
      f.eventSeq[s] = this.eventSeqs[s] as number;
      f.evKind[s * 2] = this.evKinds[s * 2] as number;
      f.evKind[s * 2 + 1] = this.evKinds[s * 2 + 1] as number;
      f.evValue[s * 2] = this.evValues[s * 2] as number;
      f.evValue[s * 2 + 1] = this.evValues[s * 2 + 1] as number;
    }
    ring.store(t);
    this.store.newestTick = t;
    this.interp.onStored(t);
  }
}

/** `frames` receiver frames: the snapshots due by each frame's time stored, then one update. */
export function runInterpFrames(s: InterpBenchState, frames: number): void {
  const now = s.now;
  const lost = s.lostPer512;
  for (let i = 0; i < frames; i++) {
    now[0] = (now[0] as number) + FRAME_MS;
    now[1] = (now[1] as number) + FRAME_MS;
    while ((now[1] as number) >= TICK_MS) {
      now[1] = (now[1] as number) - TICK_MS;
      const t = ++s.tick;
      if ((t & 511) >= lost) s.store1(t);
    }
    s.stats.advance();
    s.interp.update(0);
    s.sink += s.interp.view.count;
  }
}

export interface InterpCaseResult {
  readonly name: string;
  readonly nsPerFrame: number;
  /** Remotes drawn per frame, and the share of them extrapolated or held. */
  readonly drawn: number;
  readonly pastNewest: number;
  readonly gcs: number;
}

export interface InterpBenchResult {
  readonly frames: number;
  readonly cases: readonly InterpCaseResult[];
  readonly sink: number;
}

/** What `--strict` fails on: a GC inside a timed loop (the frame time is reported only). */
export function interpStrictFailure(result: InterpBenchResult): boolean {
  return result.cases.some((c) => c.gcs > 0);
}

/** Warms each case up in WARMUP_ROUNDS short rounds (as the other benches), then times it. */
export async function runInterpBench(
  world: CollisionWorld,
  frames = 200_000,
  warmup = 50_000,
): Promise<InterpBenchResult> {
  const cases: InterpCaseResult[] = [];
  let sink = 0;
  for (const [name, lost, remotes, defer] of [
    ["clean stream", 0, INTERP_REMOTES, false],
    ["12 of every 512 ticks lost", 12, INTERP_REMOTES, false],
    [`${INTERP_REMOTES_64} remotes, a third left out of each snapshot`, 0, INTERP_REMOTES_64, true],
  ] as const) {
    const s = new InterpBenchState(world, lost, remotes, defer);
    for (let round = 0; round < WARMUP_ROUNDS; round++) {
      runInterpFrames(s, warmupCalls(warmup, round));
    }
    const totals = s.stats.totals;
    const drawn0 = totals[STAT_REMOTE_FRAMES] as number;
    const past0 =
      (totals[STAT_REMOTE_EXTRAPOLATED] as number) + (totals[STAT_REMOTE_HELD] as number);
    const gcTimes: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) gcTimes.push(entry.startTime);
    });
    observer.observe({ entryTypes: ["gc"] });
    let ns = 0n;
    let t0 = 0;
    let t1 = 0;
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      t0 = performance.now();
      const h0 = process.hrtime.bigint();
      runInterpFrames(s, frames);
      ns = process.hrtime.bigint() - h0;
      t1 = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      observer.disconnect();
    }
    const drawn = (totals[STAT_REMOTE_FRAMES] as number) - drawn0;
    const past =
      (totals[STAT_REMOTE_EXTRAPOLATED] as number) + (totals[STAT_REMOTE_HELD] as number) - past0;
    cases.push({
      name,
      nsPerFrame: Number(ns) / frames,
      drawn: drawn / frames,
      pastNewest: drawn > 0 ? past / drawn : 0,
      gcs: countIn(gcTimes, t0, t1),
    });
    sink += s.sink;
  }
  return { frames, cases, sink };
}

/** The report `pnpm bench` prints. */
export function formatInterpBench(result: InterpBenchResult): string {
  const lines = [
    `interp frame: ${result.frames} frames per case at 144 Hz over a 60 Hz stream, ${INTERP_REMOTES} remotes on arena_greybox (and ${INTERP_REMOTES_64} with deferral)`,
  ];
  for (const c of result.cases) {
    // The estimate is for 16 remotes; the 63-remote frame is reported only.
    const estimate =
      c.drawn > INTERP_REMOTES + 0.5 ? "reported" : `estimate ${INTERP_ESTIMATE_NS} ns, reported`;
    lines.push(
      `${c.name}: ${c.nsPerFrame.toFixed(1)} ns per frame (${estimate}), ${c.drawn.toFixed(2)} drawn, ${(c.pastNewest * 100).toFixed(2)}% extrapolated ` +
        `or held, ${c.gcs} GCs (expect 0)`,
    );
  }
  lines.push(`sink: ${result.sink}`);
  return lines.join("\n");
}
