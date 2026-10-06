import { TICK_RATE } from "@game/shared";
import type { LoopHost } from "./host";

/**
 * Most ticks one wake may run (docs/05 §8.1: catch-up is capped at 5 ticks; a design constant).
 * After a longer stall (a debugger pause, a throttled background tab) the rest is dropped:
 * replaying it all at once would only flood clients with snapshots they no longer need.
 */
export const MAX_CATCHUP_TICKS = 5;

/** Whatever the loop drives: `Match` in play, a counter in tests. */
export interface Tickable {
  tick(): void;
}

/** Counters of a running loop (live; the same object for the loop's life). */
export class LoopStats {
  /** Ticks run. */
  ticks = 0;
  /** Ticks dropped after stalls. */
  dropped = 0;
  /** Host wakes, including early ones that ran no tick. */
  wakes = 0;
  /** Milliseconds spent inside `tick()` calls, summed, and the longest single wake's share. */
  readonly busyMs = new Float64Array(2);
}

/**
 * The match loop (docs/05 §8.1, M2 design §2): a monotonic-clock accumulator, re-armed through
 * `host.schedule` after every wake, never an interval timer. Each wake counts the ticks due since
 * the loop started, runs those not yet accounted for (at most MAX_CATCHUP_TICKS; then it drops
 * the rest with one warning, so less than a tick stays owed), and asks to be woken when the next
 * tick is due. A wake that comes early runs nothing and re-arms.
 *
 * The accumulator is the elapsed time since start, not a running sum of wake intervals, so
 * rounding never adds up: a second of wall time is exactly 60 ticks however the wakes fall. Tick
 * k is due at `start + k × 1000 / TICK_RATE`, and both the count of due ticks and the re-arm
 * delay come from that one expression: a host that wakes exactly when asked always finds the
 * tick due (a floor of `elapsed × 60 / 1000` can come out one short and re-arm with 0 ms
 * forever). Time lives in a typed array, so a wake boxes no double beyond the host's own `now()`.
 */
export class MatchLoop {
  readonly stats = new LoopStats();
  /** [0] start time (ms), [1] wake time, [2] scratch. */
  private readonly time = new Float64Array(3);
  /** Ticks run or dropped since start. */
  private accounted = 0;
  private running = false;
  /** A wake is scheduled and has not run yet (so a restart never arms a second chain). */
  private armed = false;
  /** Bumped by start(), so a wake notices a restart made from inside one of its ticks. */
  private generation = 0;
  private readonly wakeCb: () => void;

  constructor(
    private readonly target: Tickable,
    private readonly host: LoopHost,
  ) {
    this.wakeCb = () => this.wake();
  }

  /** Starts counting from now; the first tick runs one tick period later. A no-op if running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation++;
    this.time[0] = this.host.now();
    this.accounted = 0;
    // After stop(), a wake may still be pending: it re-arms for the new start instead.
    if (!this.armed) this.arm();
  }

  /** No tick runs after this; a wake already scheduled returns without re-arming. */
  stop(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Whether tick `k` (1-based since start), due at `start + k × 1000 / TICK_RATE`, is due by the
   * wake time `time[1]`. A boolean, so no double crosses a call.
   */
  private isDue(k: number): boolean {
    return (this.time[0] as number) + (k * 1000) / TICK_RATE <= (this.time[1] as number);
  }

  /** How many ticks are due by the wake time `time[1]`. */
  private dueBy(): number {
    const t = this.time;
    let n = Math.floor((((t[1] as number) - (t[0] as number)) * TICK_RATE) / 1000);
    // Negative when the clock stepped back (it must not; hosts are outside our control).
    if (n < 0) return 0;
    // The floor can be one off either way; settle it on the expression the re-arm uses.
    while (this.isDue(n + 1)) n++;
    while (n > 0 && !this.isDue(n)) n--;
    return n;
  }

  private arm(): void {
    this.armed = true;
    const t = this.time;
    // Until the next tick is due; positive unless the ticks themselves ran past it.
    t[2] = (t[0] as number) + ((this.accounted + 1) * 1000) / TICK_RATE - this.host.now();
    this.host.schedule(this.wakeCb, Math.max(0, t[2] as number));
  }

  private wake(): void {
    this.armed = false;
    if (!this.running) return;
    const gen = this.generation;
    const t = this.time;
    const host = this.host;
    const stats = this.stats;
    stats.wakes++;
    t[1] = host.now();
    const due = this.dueBy() - this.accounted;
    let ran = 0;
    while (ran < due && ran < MAX_CATCHUP_TICKS && this.running && this.generation === gen) {
      this.target.tick();
      ran++;
    }
    stats.ticks += ran;
    // A tick stopped and restarted the loop: the restart counts afresh and has armed its wake.
    if (this.generation !== gen) return;
    this.accounted += ran;
    if (ran < due && this.running) {
      const dropped = due - ran;
      this.accounted += dropped;
      stats.dropped += dropped;
      host.log("warn", `match loop fell behind: ran ${ran} ticks, dropped ${dropped}`);
    }
    if (ran > 0) {
      t[2] = host.now() - (t[1] as number);
      stats.busyMs[0] = (stats.busyMs[0] as number) + (t[2] as number);
      stats.busyMs[1] = Math.max(stats.busyMs[1] as number, t[2] as number);
    }
    if (this.running) this.arm();
  }
}

/** Creates a loop for `target` on `host` and starts it. */
export function startMatchLoop(target: Tickable, host: LoopHost): MatchLoop {
  const loop = new MatchLoop(target, host);
  loop.start();
  return loop;
}
