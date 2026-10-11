import { PerformanceObserver, performance } from "node:perf_hooks";
import type { LoopStats } from "../match/loop";
import type { TickHistogram, TickWindow } from "../match/tickStats";
import type { ServerMatch, TimedPass } from "./host";
import type { JsonLog } from "./log";

/**
 * The server's metrics (D-029, D-036; M3 design §2.14): GC pauses, memory, CPU, wire traffic and
 * the match counters, over two windows besides the tick histograms' own. The **run window**
 * starts at listen, again after `--metrics-discard <s>`, and on the console's `metrics reset`; a
 * match's own run window also starts again on rcon's `metrics reset` from one of its clients
 * (D-042), leaving the process's and the other matches'. The `/metrics` page and the
 * `--metrics-out` file report it. The **interval window** is the time since
 * the last metrics line (`sv_metricsInterval`), which reports it and starts the next. Per match:
 * its tick times, counters and traffic; per process: the loop pass (the NET-09 judge), GC, memory,
 * CPU and the traffic of every match. Every number covers its window: counters and CPU as the
 * change since the window began, memory as the current sample and the window's peak (sampled once a
 * second by `sampleMemory`, so a run judged at shutdown still sees what play cost). Bandwidth is
 * payload plus WebSocket framing, KB = 1000 B. Everything here runs once a second, a few times a
 * minute or on a request, never per tick: it allocates freely.
 */

/** GC pauses in one window: how many, their total and the longest, ms. */
export class GcWindow {
  count = 0;
  totalMs = 0;
  maxMs = 0;

  record(ms: number): void {
    this.count++;
    this.totalMs += ms;
    if (ms > this.maxMs) this.maxMs = ms;
  }

  reset(): void {
    this.count = 0;
    this.totalMs = 0;
    this.maxMs = 0;
  }
}

/**
 * The process's GC pauses from a `PerformanceObserver` on "gc" entries (`--trace-gc` cross-checks
 * it by hand). Node reports an entry shortly after its GC, from the event loop, so a window holds
 * the pauses reported before it closed.
 */
export class GcTracker {
  readonly run = new GcWindow();
  readonly interval = new GcWindow();
  private observer: PerformanceObserver | null = null;

  /** One pause of `ms` (the observer's entries; tests call it directly). */
  record(ms: number): void {
    this.run.record(ms);
    this.interval.record(ms);
  }

  start(): void {
    if (this.observer !== null) return;
    const observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) this.record(e.duration);
    });
    observer.observe({ entryTypes: ["gc"] });
    this.observer = observer;
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}

/** INPUT packets lost of those sent between `b` and `c`, in percent (3 decimals); 0 for none. */
function lossPct(c: MatchCounts, b: MatchCounts): number {
  const lost = c.inputLost - b.inputLost;
  const sent = c.inputPackets - b.inputPackets + lost;
  return sent > 0 ? round3((100 * lost) / sent) : 0;
}

/** A match's running counters at one moment, so a window reports what happened since. */
class MatchCounts {
  starved = 0;
  strikes = 0;
  snapshots = 0;
  fullSnapshots = 0;
  deferredEntities = 0;
  deferredSnapshots = 0;
  snapshotOverflow = 0;
  schedOverrun = 0;
  kicks = 0;
  rateLimited = 0;
  inputPackets = 0;
  inputLost = 0;
  bytesIn = 0;
  bytesOut = 0;

  read(m: ServerMatch): this {
    const c = m.match.metrics;
    this.starved = c.starved;
    this.strikes = c.strikes;
    this.snapshots = c.snapshots;
    this.fullSnapshots = c.fullSnapshots;
    this.deferredEntities = c.deferredEntities;
    this.deferredSnapshots = c.deferredSnapshots;
    this.snapshotOverflow = c.snapshotOverflow;
    this.schedOverrun = c.schedOverrun;
    this.kicks = c.kicks;
    this.rateLimited = c.rateLimited;
    this.inputPackets = c.inputPackets;
    this.inputLost = c.inputLost;
    this.bytesIn = m.traffic.bytesIn;
    this.bytesOut = m.traffic.bytesOut;
    return this;
  }
}

/**
 * One match's window bases (D-047: a match joins or leaves the process at any time): its counters
 * at its run window's start, at the process run window's start (the process's traffic), at the
 * interval's start, and a reading of now.
 */
class MatchWindows {
  readonly runBase = new MatchCounts();
  readonly processBase = new MatchCounts();
  readonly intervalBase = new MatchCounts();
  readonly current = new MatchCounts();
  /** Its run window's start (ms): the process's, or its own `metrics reset`'s. */
  runStart = 0;

  constructor(m: ServerMatch, now: number) {
    this.runBase.read(m);
    this.processBase.read(m);
    this.intervalBase.read(m);
    this.runStart = now;
  }
}

/** Memory in bytes, as `process.memoryUsage()` reports it. */
export interface MemorySample {
  readonly heapUsed: number;
  readonly external: number;
  readonly rss: number;
}

export interface MetricsSources {
  /**
   * The process's matches, read live: a match added later gets its windows from `addMatch` (or
   * when first seen), and one taken out must be passed to `removeMatch` first.
   */
  readonly matches: readonly ServerMatch[];
  readonly pass: TimedPass;
  /** The loop's counters (dropped ticks, yields). */
  readonly loop: () => LoopStats;
  /** Open WebSocket connections. */
  readonly connections: () => number;
  /** Monotonic milliseconds; `performance.now` when absent. */
  readonly now?: () => number;
  /** `process.memoryUsage` when absent. */
  readonly memory?: () => MemorySample;
  /** Process CPU time (user + system), µs; `process.cpuUsage` when absent. */
  readonly cpuMicros?: () => number;
}

const MB = 1024 * 1024;

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Bytes per second as KB/s (KB = 1000 B, D-036). */
function kbPerS(bytes: number, seconds: number): number {
  return seconds > 0 ? round3(bytes / seconds / 1000) : 0;
}

/** A tick window as JSON, µs. */
export function windowJson(w: TickWindow) {
  return {
    count: w.count,
    p50: w.percentileUs(50),
    p95: w.percentileUs(95),
    p99: w.percentileUs(99),
    max: w.maxUs,
  };
}

function lastSecondJson(h: TickHistogram) {
  return { p50: h.lastP50Us, p99: h.lastP99Us, max: h.lastMaxUs };
}

function gcJson(w: GcWindow) {
  return { count: w.count, maxMs: round3(w.maxMs), totalMs: round3(w.totalMs) };
}

/** The current sample, and the window's peaks of heapUsed + external and of RSS. */
function memoryJson(m: MemorySample, peaks: Float64Array, at: number) {
  return {
    heapUsed: round3(m.heapUsed / MB),
    external: round3(m.external / MB),
    rss: round3(m.rss / MB),
    peakHeapExternal: round3((peaks[at] as number) / MB),
    peakRss: round3((peaks[at + 1] as number) / MB),
  };
}

/** CPU ms per wall second between two readings (µs, ms). */
function cpuPerWall(cpuMicros: number, wallMs: number): number {
  return wallMs > 0 ? round3(cpuMicros / 1000 / (wallMs / 1000)) : 0;
}

function processCpuMicros(): number {
  const u = process.cpuUsage();
  return u.user + u.system;
}

export class ServerMetrics {
  readonly gc = new GcTracker();
  private readonly now: () => number;
  private readonly memory: () => MemorySample;
  private readonly cpuMicros: () => number;
  /**
   * [0] start, [1] run window start, [2] interval start (ms); [3] CPU µs at the run window's start,
   * [4] at the interval's; [5] passes at the run window's start.
   */
  private readonly t = new Float64Array(6);
  /** Peak heapUsed + external and peak RSS (bytes): [0..1] the run window, [2..3] the interval. */
  private readonly peaks = new Float64Array(4);
  /** Each match's window bases, by match. */
  private readonly windows = new Map<ServerMatch, MatchWindows>();
  /**
   * The traffic of matches removed inside the windows (D-047), so the process's bytes never step
   * back: [0] in and [1] out in the run window, [2] in and [3] out in the interval.
   */
  private readonly retired = new Float64Array(4);
  /** Loop counters at the run window's and the interval's start: dropped, yields. */
  private readonly loopBase = new Float64Array(4);

  constructor(
    private readonly src: MetricsSources,
    private readonly log: JsonLog,
  ) {
    this.now = src.now ?? (() => performance.now());
    this.memory = src.memory ?? (() => process.memoryUsage());
    this.cpuMicros = src.cpuMicros ?? processCpuMicros;
    this.t[0] = this.now();
    this.resetRun();
    this.resetInterval();
  }

  /**
   * Starts the run window again for the process and every match: tick histograms, GC, the loop's
   * and the matches' counters and traffic (`--metrics-discard`, the console's `metrics reset`).
   */
  resetRun(): void {
    const src = this.src;
    this.t[1] = this.now();
    this.t[3] = this.cpuMicros();
    this.t[5] = src.pass.passes;
    this.peaks[0] = 0;
    this.peaks[1] = 0;
    src.pass.ticks.resetRun();
    this.gc.run.reset();
    const loop = src.loop();
    this.loopBase[0] = loop.dropped;
    this.loopBase[1] = loop.yields;
    this.retired[0] = 0;
    this.retired[1] = 0;
    for (let i = 0; i < src.matches.length; i++) {
      const m = src.matches[i] as ServerMatch;
      this.windowsOf(m).processBase.read(m);
      this.resetMatch(m, this.t[1] as number);
    }
  }

  /**
   * A match that joined the process (D-047's `match_add`): its windows start now, from its
   * counters as they are. Idempotent.
   */
  addMatch(m: ServerMatch): void {
    this.windowsOf(m);
  }

  /**
   * A match leaving the process (`match_remove`), before it leaves `matches`: its traffic stays in
   * the process's run window and interval; its own windows go.
   */
  removeMatch(m: ServerMatch): void {
    const w = this.windows.get(m);
    if (w === undefined) return;
    const c = w.current.read(m);
    this.retired[0] = (this.retired[0] as number) + c.bytesIn - w.processBase.bytesIn;
    this.retired[1] = (this.retired[1] as number) + c.bytesOut - w.processBase.bytesOut;
    this.retired[2] = (this.retired[2] as number) + c.bytesIn - w.intervalBase.bytesIn;
    this.retired[3] = (this.retired[3] as number) + c.bytesOut - w.intervalBase.bytesOut;
    this.windows.delete(m);
  }

  /** `m`'s windows, started now when it has none yet. */
  private windowsOf(m: ServerMatch): MatchWindows {
    let w = this.windows.get(m);
    if (w === undefined) {
      w = new MatchWindows(m, this.now());
      this.windows.set(m, w);
    }
    return w;
  }

  /**
   * Starts the run window again for the match named `name` only: its tick histogram, counters and
   * traffic; the process's window and the other matches' stay (rcon's `metrics reset`, D-042, M3
   * design §2.14). False when there is no such match.
   */
  resetMatchRun(name: string): boolean {
    const matches = this.src.matches;
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i] as ServerMatch;
      if (m.name !== name) continue;
      this.resetMatch(m, this.now());
      return true;
    }
    return false;
  }

  /** `m`'s run window from `at` (ms; the process's start when the whole run resets). */
  private resetMatch(m: ServerMatch, at: number): void {
    const w = this.windowsOf(m);
    w.runStart = at;
    m.ticks.resetRun();
    w.runBase.read(m);
  }

  /**
   * Reads the memory and raises both windows' peaks; the server calls it once a second (and each
   * report reads it too), so a window's peak is its largest 1 s sample.
   */
  sampleMemory(): MemorySample {
    const m = this.memory();
    const heapExt = m.heapUsed + m.external;
    const p = this.peaks;
    for (let at = 0; at < 4; at += 2) {
      if (heapExt > (p[at] as number)) p[at] = heapExt;
      if (m.rss > (p[at + 1] as number)) p[at + 1] = m.rss;
    }
    return m;
  }

  /** Seconds in the run window so far. */
  get runSeconds(): number {
    return (this.now() - (this.t[1] as number)) / 1000;
  }

  /** The `/metrics` page and the `--metrics-out` file: the run windows, process and per match. */
  json() {
    const src = this.src;
    // One clock reading for every window, so a match whose window is the process's reports the
    // same seconds and rates.
    const now = this.now();
    const runS = (now - (this.t[1] as number)) / 1000;
    const loop = src.loop();
    const memory = this.sampleMemory();
    const cpu = this.cpuMicros() - (this.t[3] as number);
    let bytesIn = this.retired[0] as number;
    let bytesOut = this.retired[1] as number;
    // A null-prototype record: a match name such as "__proto__" is an own key like any other.
    const matches: Record<string, unknown> = Object.create(null);
    for (let i = 0; i < src.matches.length; i++) {
      const m = src.matches[i] as ServerMatch;
      const w = this.windowsOf(m);
      const c = w.current.read(m);
      const b = w.runBase;
      const p = w.processBase;
      bytesIn += c.bytesIn - p.bytesIn;
      bytesOut += c.bytesOut - p.bytesOut;
      const matchS = (now - w.runStart) / 1000;
      matches[m.name] = {
        runS: round3(matchS),
        map: m.match.mapName,
        players: m.match.sessionCount,
        serverTick: m.match.serverTick,
        tickUs: windowJson(m.ticks.run),
        lastSecondUs: lastSecondJson(m.ticks),
        starved: c.starved - b.starved,
        strikes: c.strikes - b.strikes,
        snapshots: c.snapshots - b.snapshots,
        fullSnapshots: c.fullSnapshots - b.fullSnapshots,
        // The byte-budget scheduler (D-046): players left out and the snapshots that left any
        // out; the largest staleness since the match started (1 without deferral, 2 at most).
        deferredEntities: c.deferredEntities - b.deferredEntities,
        deferredSnapshots: c.deferredSnapshots - b.deferredSnapshots,
        maxStaleness: m.match.metrics.maxStaleness,
        snapshotOverflow: c.snapshotOverflow - b.snapshotOverflow,
        schedOverrun: c.schedOverrun - b.schedOverrun,
        kicks: c.kicks - b.kicks,
        // D-041: packets the rate limits dropped, and INPUT packets received and lost on the way
        // in (of those sent: received + lost).
        rateLimited: c.rateLimited - b.rateLimited,
        inputPackets: c.inputPackets - b.inputPackets,
        inputLost: c.inputLost - b.inputLost,
        inputLossPct: lossPct(c, b),
        traffic: trafficJson(c.bytesIn - b.bytesIn, c.bytesOut - b.bytesOut, matchS),
      };
    }
    return {
      process: {
        uptimeS: round3((now - (this.t[0] as number)) / 1000),
        runS: round3(runS),
        passes: src.pass.passes - (this.t[5] as number),
        droppedTicks: loop.dropped - (this.loopBase[0] as number),
        loopYields: loop.yields - (this.loopBase[1] as number),
        tickUs: windowJson(src.pass.ticks.run),
        lastSecondUs: lastSecondJson(src.pass.ticks),
        cpuMsPerWallS: cpuPerWall(cpu, runS * 1000),
        gc: gcJson(this.gc.run),
        memoryMB: memoryJson(memory, this.peaks, 0),
        connections: src.connections(),
        traffic: trafficJson(bytesIn, bytesOut, runS),
      },
      matches,
    };
  }

  /**
   * Logs the metrics lines of the interval since the last call: one `metrics` line per match
   * (with `match`) and one for the process, then starts the next interval.
   */
  logInterval(): void {
    const src = this.src;
    const s = (this.now() - (this.t[2] as number)) / 1000;
    const memory = this.sampleMemory();
    const cpu = this.cpuMicros() - (this.t[4] as number);
    let bytesIn = this.retired[2] as number;
    let bytesOut = this.retired[3] as number;
    for (let i = 0; i < src.matches.length; i++) {
      const m = src.matches[i] as ServerMatch;
      const w = this.windowsOf(m);
      const c = w.current.read(m);
      const b = w.intervalBase;
      bytesIn += c.bytesIn - b.bytesIn;
      bytesOut += c.bytesOut - b.bytesOut;
      this.log("info", "metrics", {
        match: m.name,
        s: round3(s),
        players: m.match.sessionCount,
        tickUs: windowJson(m.ticks.interval),
        starved: c.starved - b.starved,
        strikes: c.strikes - b.strikes,
        fullSnapshots: c.fullSnapshots - b.fullSnapshots,
        deferredEntities: c.deferredEntities - b.deferredEntities,
        maxStaleness: m.match.metrics.maxStaleness,
        snapshotOverflow: c.snapshotOverflow - b.snapshotOverflow,
        kicks: c.kicks - b.kicks,
        rateLimited: c.rateLimited - b.rateLimited,
        inputLossPct: lossPct(c, b),
        kbInPerS: kbPerS(c.bytesIn - b.bytesIn, s),
        kbOutPerS: kbPerS(c.bytesOut - b.bytesOut, s),
      });
    }
    const loop = src.loop();
    this.log("info", "metrics", {
      s: round3(s),
      tickUs: windowJson(src.pass.ticks.interval),
      droppedTicks: loop.dropped - (this.loopBase[2] as number),
      gc: { count: this.gc.interval.count, maxMs: round3(this.gc.interval.maxMs) },
      memoryMB: memoryJson(memory, this.peaks, 2),
      cpuMsPerWallS: cpuPerWall(cpu, s * 1000),
      connections: src.connections(),
      kbInPerS: kbPerS(bytesIn, s),
      kbOutPerS: kbPerS(bytesOut, s),
    });
    this.resetInterval();
  }

  private resetInterval(): void {
    const src = this.src;
    this.t[2] = this.now();
    this.t[4] = this.cpuMicros();
    this.peaks[2] = 0;
    this.peaks[3] = 0;
    src.pass.ticks.resetInterval();
    this.gc.interval.reset();
    const loop = src.loop();
    this.loopBase[2] = loop.dropped;
    this.loopBase[3] = loop.yields;
    this.retired[2] = 0;
    this.retired[3] = 0;
    for (let i = 0; i < src.matches.length; i++) {
      const m = src.matches[i] as ServerMatch;
      m.ticks.resetInterval();
      this.windowsOf(m).intervalBase.read(m);
    }
  }
}

function trafficJson(bytesIn: number, bytesOut: number, seconds: number) {
  return {
    bytesIn,
    bytesOut,
    kbInPerS: kbPerS(bytesIn, seconds),
    kbOutPerS: kbPerS(bytesOut, seconds),
  };
}
