/**
 * The client's net counters for the netgraph and the NET tests (M2 design §2 "HUD"): totals since
 * connecting plus rolling one-second windows made of ten 100 ms buckets, so "per second" figures
 * move smoothly instead of jumping once a second. Everything is preallocated; time comes from the
 * caller's clock slot `now[0]` (ms).
 */

export const STAT_SNAPSHOTS = 0;
/** Snapshot ticks skipped over (lost or still in flight when a newer one arrived). */
export const STAT_SNAPSHOTS_LOST = 1;
export const STAT_BYTES_IN = 2;
export const STAT_BYTES_OUT = 3;
export const STAT_PACKETS_OUT = 4;
/** Reconciliations that found the prediction wrong (docs/05 §5). */
export const STAT_CORRECTIONS = 5;
/** Sum of the corrections' visible distances at the latest tick, u. */
export const STAT_CORRECTION_DIST = 6;
/** Largest correction distance, u (a maximum, not a sum). */
export const STAT_CORRECTION_MAX = 7;
/** Snapshots the server flagged starved: it repeated a cmd of ours that had not arrived. */
export const STAT_STARVED = 8;
/** Fast-forward and hold steps of the clock (M2 design §2 "Client clock"). */
export const STAT_CLOCK_ADJUSTMENTS = 9;
/** Snapshots simulated with cvars the client had not switched to yet (not corrections). */
export const STAT_PARAM_RESYNCS = 10;
/** Snapshots for a tick the prediction no longer held: state adopted and the clock re-anchored. */
export const STAT_HARD_RESYNCS = 11;
/** Packets that did not decode or did not fit the connection's state. */
export const STAT_STRIKES = 12;
/**
 * Of the corrections, those on a snapshot the server flagged starved: it simulated a repeat of a
 * cmd of ours that came late, so the prediction could not match (timing, not a misprediction).
 */
export const STAT_STARVED_CORRECTIONS = 13;
/**
 * Snapshots whose teleport counter changed (a spawn or respawn, D-035): the state was adopted and
 * the render offset dropped, not counted as corrections.
 */
export const STAT_TELEPORTS = 14;
/** Remote players drawn, summed over frames (D-037): the base of the two shares below. */
export const STAT_REMOTE_FRAMES = 15;
/** Of those, drawn past their newest snapshot along their velocity (at most 2 ticks). */
export const STAT_REMOTE_EXTRAPOLATED = 16;
/** Of those, held where the extrapolation stopped (no newer snapshot yet). */
export const STAT_REMOTE_HELD = 17;
/** Render-clock snaps after the first (the first places the clock): a remote jumped in time. */
export const STAT_RENDER_SNAPS = 18;
/** Remote movement events surfaced, and those lost (more than 2 in one step of a slot). */
export const STAT_REMOTE_EVENTS = 19;
export const STAT_REMOTE_EVENTS_LOST = 20;
/** Of the snapshots stored, those that were full (D-038: the first, and any without a baseline). */
export const STAT_FULL_SNAPSHOTS = 21;
/** Delta snapshots dropped because their baseline frame was not held (D-038; not struck). */
export const STAT_BASELINE_DROPS = 22;
/**
 * Players the server's byte-budget scheduler left out of the snapshots stored (deferred ids,
 * D-046), and the snapshots that left any out: 0 at 37 players or fewer.
 */
export const STAT_DEFERRED = 23;
export const STAT_DEFERRED_SNAPSHOTS = 24;
/**
 * Ticks the clock's dilation added to the prediction (negative: took away; D-039), stall frames
 * (ClientSim's HITCH_FRAME_MS) left out: over the last second, divided by TICK_RATE, about the
 * mean δ, which the netgraph can show as a percentage.
 */
export const STAT_DILATION = 25;
export const STAT_COUNT = 26;

const BUCKETS = 10;
const BUCKET_MS = 100;

function isMaxStat(stat: number): boolean {
  return stat === STAT_CORRECTION_MAX;
}

export class NetStats {
  /** Every stat since the connection started. */
  readonly totals = new Float64Array(STAT_COUNT);
  /** BUCKETS rows of STAT_COUNT values. */
  private readonly buckets = new Float64Array(BUCKETS * STAT_COUNT);
  /** The 100 ms epoch each bucket holds (−Infinity = empty). */
  private readonly epochs = new Float64Array(BUCKETS).fill(Number.NEGATIVE_INFINITY);
  /** [0] the current epoch. */
  private readonly epoch = new Float64Array([Number.NaN]);
  private row = 0;

  constructor(private readonly now: Float64Array) {
    this.advance();
  }

  /** Moves to the bucket of `now[0]`, emptying the one it reuses. Called once per frame. */
  advance(): void {
    const e = Math.floor((this.now[0] as number) / BUCKET_MS);
    if (e === (this.epoch[0] as number)) return;
    this.epoch[0] = e;
    this.row = ((e % BUCKETS) + BUCKETS) % BUCKETS;
    if ((this.epochs[this.row] as number) !== e) {
      this.epochs[this.row] = e;
      this.buckets.fill(0, this.row * STAT_COUNT, (this.row + 1) * STAT_COUNT);
    }
  }

  /** Adds `value` to a sum stat, or raises a max stat to it. */
  add(stat: number, value: number): void {
    const at = this.row * STAT_COUNT + stat;
    if (isMaxStat(stat)) {
      this.totals[stat] = Math.max(this.totals[stat] as number, value);
      this.buckets[at] = Math.max(this.buckets[at] as number, value);
    } else {
      this.totals[stat] = (this.totals[stat] as number) + value;
      this.buckets[at] = (this.buckets[at] as number) + value;
    }
  }

  /**
   * `add(stat, src[index])` for a per-frame caller: the value stays in a typed array, so a
   * fractional double never crosses the call boxed when it is not inlined (native ESM, D-041).
   */
  addFrom(stat: number, src: Float64Array, index: number): void {
    const at = this.row * STAT_COUNT + stat;
    if (isMaxStat(stat)) {
      this.totals[stat] = Math.max(this.totals[stat] as number, src[index] as number);
      this.buckets[at] = Math.max(this.buckets[at] as number, src[index] as number);
    } else {
      this.totals[stat] = (this.totals[stat] as number) + (src[index] as number);
      this.buckets[at] = (this.buckets[at] as number) + (src[index] as number);
    }
  }

  /** Each stat over the last second (sums, or the maximum for max stats), into `out`. */
  lastSecond(out: Float64Array): void {
    out.fill(0);
    const oldest = (this.epoch[0] as number) - BUCKETS + 1;
    for (let b = 0; b < BUCKETS; b++) {
      if ((this.epochs[b] as number) < oldest) continue;
      for (let s = 0; s < STAT_COUNT; s++) {
        const v = this.buckets[b * STAT_COUNT + s] as number;
        out[s] = isMaxStat(s) ? Math.max(out[s] as number, v) : (out[s] as number) + v;
      }
    }
  }

  reset(): void {
    this.totals.fill(0);
    this.buckets.fill(0);
    this.epochs.fill(Number.NEGATIVE_INFINITY);
    this.epoch[0] = Number.NaN;
    this.advance();
  }
}
