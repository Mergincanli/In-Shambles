/**
 * Tick-time histograms (M3 design §1 `tickStats.ts`, D-029; design values). Pure and clock-free:
 * the host measures each tick and records whole microseconds, so the same code serves the Node
 * server and the Worker. Recording and reading percentiles allocate nothing, and every value is
 * an integer (no double crosses a call).
 */

/** Buckets of `TICK_HIST_BUCKET_US` each, then one overflow bucket (2048 × 10 µs = 20.48 ms). */
export const TICK_HIST_BUCKETS = 2048;
export const TICK_HIST_BUCKET_US = 10;

/** Largest microsecond count a window stores (i32), so a hostile clock can't overflow it. */
const MAX_US = 0x7fffffff;

/** One window of tick times: bucket counts, the sample count and the exact maximum. */
export class TickWindow {
  /** `TICK_HIST_BUCKETS` buckets, then the overflow bucket. */
  readonly counts = new Uint32Array(TICK_HIST_BUCKETS + 1);
  count = 0;
  maxUs = 0;

  /** Adds one tick of `us` microseconds (truncated to whole, clamped to 0…2^31 − 1; NaN is 0). */
  record(us: number): void {
    const v = Math.max(0, Math.min(MAX_US, us)) | 0;
    const b = Math.min(TICK_HIST_BUCKETS, (v / TICK_HIST_BUCKET_US) | 0);
    this.counts[b] = (this.counts[b] as number) + 1;
    this.count++;
    if (v > this.maxUs) this.maxUs = v;
  }

  /**
   * The nearest-rank `percent` percentile (an integer 1–100) in microseconds: the upper edge of
   * its bucket, capped at the exact maximum, so it is at most one bucket above the true value and
   * never below it. The overflow bucket reports the maximum. 0 when the window is empty.
   */
  percentileUs(percent: number): number {
    const n = this.count;
    if (n === 0) return 0;
    // ceil(n × percent / 100) in integers: the rank of the sample the percentile names.
    const rank = Math.max(1, Math.floor((n * percent + 99) / 100));
    const counts = this.counts;
    let seen = 0;
    for (let b = 0; b < TICK_HIST_BUCKETS; b++) {
      seen += counts[b] as number;
      if (seen >= rank) return Math.min(this.maxUs, (b + 1) * TICK_HIST_BUCKET_US);
    }
    return this.maxUs;
  }

  reset(): void {
    this.counts.fill(0);
    this.count = 0;
    this.maxUs = 0;
  }
}

/**
 * Tick times of one match, or of the server's whole loop pass: a 1 s window the host closes once
 * a second (`endSecond`), keeping that second's p50/p99/max, and a run window that counts from
 * the start (or the last `resetRun`) for the metrics run (docs/06 §8).
 */
export class TickHistogram {
  readonly second = new TickWindow();
  readonly run = new TickWindow();
  /** p50, p99 and max (µs) of the last closed 1 s window. */
  lastP50Us = 0;
  lastP99Us = 0;
  lastMaxUs = 0;

  record(us: number): void {
    this.second.record(us);
    this.run.record(us);
  }

  /** Closes the 1 s window: keeps its p50/p99/max and starts the next one. */
  endSecond(): void {
    const w = this.second;
    this.lastP50Us = w.percentileUs(50);
    this.lastP99Us = w.percentileUs(99);
    this.lastMaxUs = w.maxUs;
    w.reset();
  }

  resetRun(): void {
    this.run.reset();
  }
}
