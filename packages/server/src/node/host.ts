import { performance } from "node:perf_hooks";
import { TICK_RATE } from "@game/shared";
import type { LogLevel, LoopHost } from "../match/host";
import type { LoopStats, Tickable } from "../match/loop";
import type { Match } from "../match/match";
import { TickHistogram } from "../match/tickStats";
import type { WireTraffic } from "../transport/wsTransport";
import type { JsonLog } from "./log";

/**
 * The match loop's environment in Node (D-029): the monotonic `performance.now`, a one-shot
 * `setTimeout` re-armed after every wake (never an interval; `Math.ceil`, since it truncates to
 * whole ms), and the loop's own log lines. With `pass`, those go through `TimedPass.loopLog`, so a
 * drop becomes the one `tick_drop` line; without it they are `{"ev":"loop"}` lines.
 */
export function createNodeHost(log: JsonLog, pass?: TimedPass): LoopHost {
  return {
    now: () => performance.now(),
    schedule: (cb, ms) => {
      setTimeout(cb, Math.ceil(ms));
    },
    log:
      pass === undefined
        ? (level, msg) => log(level, "loop", { msg })
        : (level, msg) => pass.loopLog(level, msg),
  };
}

/** One match the process runs, with its name, tick times and its sockets' wire traffic. */
export interface ServerMatch {
  readonly name: string;
  readonly match: Match;
  readonly ticks: TickHistogram;
  readonly traffic: WireTraffic;
}

/** The clocks `TimedPass` reads; tests and the allocation workload pass their own. */
export interface PassClock {
  /** Monotonic milliseconds. */
  now(): number;
  /** Process CPU time (user + system) in microseconds; read once a second. */
  cpuMicros(): number;
}

/** `performance.now` (which boxes the double it returns) and `process.cpuUsage` (an object). */
export const NODE_PASS_CLOCK: PassClock = {
  now: () => performance.now(),
  cpuMicros: () => {
    const u = process.cpuUsage();
    return u.user + u.system;
  },
};

/**
 * What the loop ticks (D-029): every match once per pass, each `match.tick()` timed into its
 * match's histogram and the whole pass into the process histogram (the NET-09 judge). One clock
 * read per match boundary (N + 1 per pass): a match's end is the next one's start. Once a second
 * it closes the histograms' 1 s windows and samples the process CPU time. A drop of ticks after a
 * stall is logged once as `tick_drop`, naming every match (a drop hits them all). Times live in a
 * Float64Array and reach the histograms as whole microseconds, so the pass's own code allocates
 * nothing; Node's `performance.now` boxes each double it returns (the host clock, as loop.ts notes).
 */
export class TimedPass implements Tickable {
  readonly ticks = new TickHistogram();
  /** Passes run. */
  passes = 0;
  /** Process CPU milliseconds (user + system) per wall second, over the last full second. */
  cpuMsPerWallS = 0;
  /** Loop counters, set once the loop exists, for `tick_drop`. */
  loopStats: LoopStats | null = null;
  /** [0] pass start, [1] match start, [2] now, [3] last CPU sample time, [4] its CPU µs. */
  private readonly time = new Float64Array(5);
  private dropped = 0;

  constructor(
    private readonly matches: readonly ServerMatch[],
    private readonly log: JsonLog,
    private readonly clock: PassClock = NODE_PASS_CLOCK,
  ) {
    this.time[3] = clock.now();
    this.time[4] = clock.cpuMicros();
  }

  tick(): void {
    const t = this.time;
    const clock = this.clock;
    const stats = this.loopStats;
    if (stats !== null && stats.dropped !== this.dropped) this.reportDrop(stats);
    t[0] = clock.now();
    t[1] = t[0];
    const matches = this.matches;
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i] as ServerMatch;
      m.match.tick();
      t[2] = clock.now();
      m.ticks.record(((t[2] - t[1]) * 1000 + 0.5) | 0);
      t[1] = t[2];
    }
    this.ticks.record(((t[1] - t[0]) * 1000 + 0.5) | 0);
    if (++this.passes % TICK_RATE === 0) this.endSecond();
  }

  /**
   * A line from the loop (`LoopHost.log`). The loop logs a drop right after counting it: that
   * becomes the `tick_drop` line, so a drop is reported once; anything else is `{"ev":"loop"}`.
   */
  loopLog(level: LogLevel, msg: string): void {
    const stats = this.loopStats;
    if (stats !== null && stats.dropped !== this.dropped) this.reportDrop(stats);
    else this.log(level, "loop", { msg });
  }

  private endSecond(): void {
    this.ticks.endSecond();
    const matches = this.matches;
    for (let i = 0; i < matches.length; i++) (matches[i] as ServerMatch).ticks.endSecond();
    const t = this.time;
    t[2] = this.clock.now();
    const cpu = this.clock.cpuMicros();
    const wallMs = t[2] - t[3];
    if (wallMs > 0) this.cpuMsPerWallS = (cpu - t[4]) / wallMs;
    t[3] = t[2];
    t[4] = cpu;
  }

  private reportDrop(stats: LoopStats): void {
    const dropped = stats.dropped - this.dropped;
    this.dropped = stats.dropped;
    const names: string[] = [];
    for (let i = 0; i < this.matches.length; i++) names.push((this.matches[i] as ServerMatch).name);
    this.log("warn", "tick_drop", { dropped, totalDropped: stats.dropped, matches: names });
  }
}
