import { TICK_RATE } from "@game/shared";

/**
 * The client clock (docs/05 §1.3, §8.2–§8.3; M2 design §2 "Client clock"; D-028, D-039). The
 * client predicts in server-tick space: its tick T is the server's tick T, and it runs ahead of
 * the server by the round trip plus an input buffer, so that the cmd for T reaches the server just
 * before the server simulates T.
 *
 * - **Handshake:** pings every HANDSHAKE_PING_SPACING_MS from WELCOME on, until five pongs have
 *   come back; their median is the round trip. At the first snapshot A the client jumps to tick
 *   A + ceil(RTT / tick) + cl_inputBuffer (`leadTicks`).
 * - **Ongoing:** a ping a second feeds EWMAs of the round trip and its jitter. Each snapshot's
 *   `inputBufferHealth` feeds an EWMA (the mean M, over about 30 snapshots) and a window of the
 *   last LOW_WINDOW healths, whose minimum is the low edge L. A frame runs every tick it owes at
 *   once, so with long or irregular frames cmds reach the server in bursts and the health
 *   saw-tooths: the mean can look fine while the low point of each burst starves the server. So
 *   the clock steers the low edge to cl_inputBuffer (the target), with the asymmetric hybrid of
 *   D-039 (M3 design §2.7):
 *   - **Dilation:** the prediction runs at (1 + δ) × real time, |δ| ≤ DIL_MAX (ClientSim scales
 *     its accumulator by it). It speeds up fast, on the low edge of the last LOW_FAST_WINDOW
 *     snapshots (adding lead never starves, so reacting to a lone dip is safe), and slows down
 *     only on the full window's low edge and the mean, so any dip below the target in the last
 *     1.5 s blocks it (D-028's lesson: short windows miss the longest frames).
 *   - **Coarse steps** for big errors (D-028's machinery): a fast-forward of k ticks (predicted
 *     and sent at once) once the low edge is target − 2 or lower in a pattern of dips
 *     (`recurring`) that stopped deepening, to target − 1 (dilation closes the last tick: +3%
 *     alone would starve a 3-tick deficit for over 1.6 s); a hold of k tick periods only once the
 *     whole window sits target + 6 or more above, to target + 2.
 *   With steady frames on a clean link the health is constant, so the mean sits at cl_inputBuffer;
 *   bursts and jitter raise the mean by their spread, within MAX_ADAPTIVE_TICKS. The spread a full
 *   window measured is the adaptive lead an anchor adds (`leadTicks`, `onResync`). Each step is a
 *   clock adjustment in the netgraph, which shows the mean and the low edge (δ is ready for it:
 *   `dilation`, and ClientSim's `STAT_DILATION`).
 *
 * A fast-forward's skip is hidden by the render offset; a hold shows as a short slowdown of the
 * drawn player (up to k ticks). The constants below are design values, not tunables. Time comes
 * from the caller's clock slot `now[0]` (ms).
 */

/** Milliseconds per tick. */
export const TICK_MS = 1000 / TICK_RATE;
/** Round-trip samples the handshake takes the median of (docs/05 §8.3). */
export const HANDSHAKE_PINGS = 5;
/** The handshake sends a ping this often until it has its samples (lost pings are re-sent). */
export const HANDSHAKE_PING_SPACING_MS = 50;
/** After the handshake, one ping per second (docs/05 §8.3). */
export const PING_INTERVAL_MS = 1000;
/** EWMA weight of a new round-trip sample, and of its deviation for the jitter. */
const RTT_WEIGHT = 1 / 8;
/** EWMA weight of a snapshot's input buffer health: about 30 snapshots. */
const HEALTH_WEIGHT = 1 / 30;
/**
 * Snapshots the low edge looks back over: 1.5 s at 60 Hz, long enough to hold the deepest dip of
 * a frame rhythm with occasional long frames (15% of them at 60 fps: about 13 per window), short
 * enough that a spread that went away is released within a couple of seconds.
 */
export const LOW_WINDOW = 90;
/**
 * Fast-forward when the low edge falls below target − this (at the default target: a dip to 0,
 * one tick from starving) …
 */
const LOW_MARGIN = 1;
/**
 * … provided the dips are a pattern: this many separate ones in the window, or the newest lasting
 * FAST_FORWARD_RUN snapshots (a round trip that grew). A lone dip (a lost INPUT, two within 1.5 s
 * on wan-100-loss1 now and then) is left to dilation: it does not starve, and a step's skip costs
 * a tick of motion in the render offset (about 11 u at strafe-jump speed).
 */
const FAST_FORWARD_DIPS = 3;
/** … snapshots (100 ms). */
const FAST_FORWARD_RUN = 6;
/**
 * The largest dilation, ± (docs/05 §8.2): 1.8 ticks a second at 60 Hz, below what a player sees
 * as the drawn motion speeding up or slowing down.
 */
export const DIL_MAX = 0.03;
/** δ per tick of error below the cap (design): a tick off is ±2%, a tick and a half the cap. */
const DIL_GAIN = 0.02;
/**
 * Speed up once the fast low edge is this far below the target (ticks; design): the healths are
 * integers, so one tick below.
 */
const SPEED_UP_DEADBAND = 0.5;
/**
 * The fast low edge: the lowest health of this many snapshots (0.5 s; design). It reacts to a
 * deficit within a round trip and forgets a dip after half a second.
 */
export const LOW_FAST_WINDOW = 30;
/** Slow down only when the low edge and the mean are both this far above the target (ticks). */
const SLOW_DOWN_ABOVE = 1;
/**
 * Hold only when the full window's low edge is this far above the target (ticks; design): a round
 * trip that fell by 100 ms or more, a stall's lead. Smaller excesses are dilation's.
 */
const HOLD_ABOVE = 6;
/** … back to target + this (dilation gives back the rest). */
const HOLD_TO = 2;
/**
 * Fast-forwards never take the mean health past target + this (ticks): the adaptive part of the
 * buffer is bounded, so a pathological host or link pays in starved cmds rather than latency
 * without bound. 8 ticks (133 ms) were sized in M2 for the burst of a 100 ms frame (6 ticks, then
 * the stall limit) plus the ±1 tick jitter of wan-150-loss2; since D-039 raised ClientSim's
 * HITCH_FRAME_MS to 150 ms, frames of 133–150 ms pay their burst's tail in starved cmds by
 * design, and the 83–125 ms frames NET-04 measures stay within the cap. Once the window's
 * average is more than CAP_EXCESS past it (after a round trip fell), the clock slows down at the
 * full DIL_MAX.
 */
export const MAX_ADAPTIVE_TICKS = 8;
/** See MAX_ADAPTIVE_TICKS (ticks; D-028's hold threshold, now dilation's). */
const CAP_EXCESS = 2;
/**
 * The health clamps to i8 (docs/05 §8.2): a sample at the floor has an unknown depth, and while
 * the cmds are not arriving (an uplink outage) no fast-forward helps, so it never asks for one.
 */
const HEALTH_FLOOR = -128;
/**
 * A shallow hard resync grows the adaptive lead only when another came within this long (ms, the
 * window's 1.5 s): like a lone dip, a lone long frame is left alone, since growing for it only
 * costs a hold later.
 */
const RESYNC_PATTERN_MS = LOW_WINDOW * TICK_MS;
/** Largest single fast-forward, in ticks (the per-frame tick cap). */
export const MAX_FAST_FORWARD_TICKS = 5;
/** Largest single hold, in tick periods (half a second). */
export const MAX_HOLD_TICKS = 30;
/**
 * Pings in flight that can still be matched to their send time: at the handshake's spacing, a
 * round trip up to 3.2 s (a slot reused before its pong came back would never be answered).
 */
export const PING_SLOTS = 64;

// Slots of ClientClock.t.
const RTT = 0;
const JITTER = 1;
const HEALTH = 2;
const LAST_PING = 3;
const SCRATCH = 4;
const LAST_RESYNC = 5;
const AVERAGE = 6;

export interface ClientClockOptions {
  /**
   * False keeps δ at 0 (the steps stay): NET-07's control, which must fail. Tests only; true by
   * default.
   */
  readonly dilation?: boolean;
}

export class ClientClock {
  /** [rtt ms, jitter ms, health EWMA, last ping sent, scratch, last resync, window average]. */
  private readonly t = new Float64Array(7);
  /**
   * [0] the dilation δ (`dilation`), for ClientSim's frame: a getter's double would box per
   * frame under native ES modules.
   */
  readonly dil = new Float64Array(1);
  /** The lowest health of the last LOW_FAST_WINDOW snapshots in the window. */
  private lowFast = 0;
  /** The last LOW_WINDOW healths (integers, moved by each step), a ring from `windowHead`. */
  private readonly recent = new Int32Array(LOW_WINDOW);
  private windowHead = 0;
  private windowCount = 0;
  /** Sum of the window's healths (its exact average bounds the adaptive part; the EWMA lags). */
  private windowSum = 0;
  /** The lowest health in the window (the low edge; the last one while the window is empty). */
  private low = 0;
  /** The previous health fed (moved by each step). */
  private lastHealth = 0;
  /**
   * The lead an anchor adds to cl_inputBuffer for the spread (ticks, 0..MAX_ADAPTIVE_TICKS): what
   * a full window measured (average − low edge, and no more than the average's lead over the
   * target), so the low edge lands on the target, kept across anchors so a re-anchor does not
   * forget the frame rhythm; a second shallow hard resync within the window grows it.
   */
  adaptiveTicks = 0;
  private readonly samples = new Float64Array(HANDSHAKE_PINGS);
  private readonly pingSentAt = new Float64Array(PING_SLOTS);
  /** The ping id each slot waits for, −1 once answered. */
  private readonly pingIds = new Int32Array(PING_SLOTS).fill(-1);
  private nextPingId = 0;
  /** Round-trip samples taken so far (the handshake needs HANDSHAKE_PINGS). */
  sampleCount = 0;
  /** Health samples in the EWMA since the last anchor. */
  healthSamples = 0;
  /** Snapshots up to this tick don't feed the health EWMA (startup fill, a step in flight). */
  ignoreHealthThroughTick = 0;
  /**
   * Fast-forward and hold steps asked for. ClientSim takes each, unless a hard resync in the same
   * poll drops it; its STAT_CLOCK_ADJUSTMENTS counts the steps taken.
   */
  adjustments = 0;
  /** Of those, the fast-forwards and the holds. */
  fastForwards = 0;
  holds = 0;

  private readonly dilationOn: boolean;

  constructor(
    private readonly now: Float64Array,
    options: ClientClockOptions = {},
  ) {
    this.dilationOn = options.dilation ?? true;
    this.reset();
  }

  reset(): void {
    const t = this.t;
    t.fill(0);
    this.dil[0] = 0;
    this.windowHead = 0;
    this.windowCount = 0;
    this.windowSum = 0;
    this.low = 0;
    this.lowFast = 0;
    this.lastHealth = 0;
    this.adaptiveTicks = 0;
    t[LAST_PING] = Number.NEGATIVE_INFINITY;
    t[LAST_RESYNC] = Number.NEGATIVE_INFINITY;
    this.pingIds.fill(-1);
    this.sampleCount = 0;
    this.healthSamples = 0;
    this.ignoreHealthThroughTick = 0;
    this.adjustments = 0;
    this.fastForwards = 0;
    this.holds = 0;
  }

  /** The round trip, ms (the handshake median, then the EWMA). */
  get rttMs(): number {
    return this.t[RTT] as number;
  }

  /** EWMA of the round trip's deviation, ms. */
  get jitterMs(): number {
    return this.t[JITTER] as number;
  }

  /** EWMA of the snapshots' input buffer health, ticks. */
  get bufferHealth(): number {
    return this.t[HEALTH] as number;
  }

  /**
   * The low edge: the lowest input buffer health of the last LOW_WINDOW snapshots, ticks (after
   * an anchor, the last one until a snapshot refills the window). The clock keeps it at
   * cl_inputBuffer − LOW_MARGIN or more, lifting it to cl_inputBuffer; the mean sits above it by
   * the spread.
   */
  get bufferLow(): number {
    return this.low;
  }

  /** The fast low edge: the lowest health of the last LOW_FAST_WINDOW snapshots, ticks. */
  get bufferLowFast(): number {
    return this.lowFast;
  }

  /**
   * The dilation δ the prediction runs at, (1 + δ) × real time, |δ| ≤ DIL_MAX (0 with the
   * `dilation: false` test option).
   */
  get dilation(): number {
    return this.dil[0] as number;
  }

  get handshakeDone(): boolean {
    return this.sampleCount >= HANDSHAKE_PINGS;
  }

  /** Whether a ping is due now: every HANDSHAKE_PING_SPACING_MS until the handshake is done. */
  pingDue(): boolean {
    const t = this.t;
    const spacing = this.handshakeDone ? PING_INTERVAL_MS : HANDSHAKE_PING_SPACING_MS;
    return (this.now[0] as number) - (t[LAST_PING] as number) >= spacing;
  }

  /** The id for a ping sent now (u16), with its send time recorded. */
  nextPing(): number {
    const id = this.nextPingId;
    this.nextPingId = (id + 1) & 0xffff;
    const slot = id & (PING_SLOTS - 1);
    this.pingIds[slot] = id;
    this.pingSentAt[slot] = this.now[0] as number;
    this.t[LAST_PING] = this.now[0] as number;
    return id;
  }

  /**
   * The id for a keepalive ping (D-041): unique like `nextPing`'s, but never registered, so its
   * pong (read up to a keepalive period late) is no round-trip sample. It also forgets the pings
   * still in flight, whose pongs a hidden page would read just as late.
   */
  keepalivePing(): number {
    this.pingIds.fill(-1);
    const id = this.nextPingId;
    this.nextPingId = (id + 1) & 0xffff;
    return id;
  }

  /** Takes the round trip of the pong for `id`; false for an unknown or repeated id. */
  onPong(id: number): boolean {
    const slot = id & (PING_SLOTS - 1);
    if (this.pingIds[slot] !== id) return false;
    this.pingIds[slot] = -1;
    const t = this.t;
    t[SCRATCH] = (this.now[0] as number) - (this.pingSentAt[slot] as number);
    if (this.sampleCount < HANDSHAKE_PINGS) {
      this.samples[this.sampleCount++] = t[SCRATCH] as number;
      if (this.sampleCount === HANDSHAKE_PINGS) this.takeMedian();
      return true;
    }
    this.sampleCount++;
    const dev = Math.abs((t[SCRATCH] as number) - (t[RTT] as number));
    t[JITTER] = (t[JITTER] as number) + (dev - (t[JITTER] as number)) * RTT_WEIGHT;
    t[RTT] = (t[RTT] as number) + ((t[SCRATCH] as number) - (t[RTT] as number)) * RTT_WEIGHT;
    return true;
  }

  private takeMedian(): void {
    const s = this.samples;
    s.sort();
    const t = this.t;
    t[RTT] = s[HANDSHAKE_PINGS >> 1] as number;
    let dev = 0;
    for (let i = 0; i < HANDSHAKE_PINGS; i++)
      dev += Math.abs((s[i] as number) - (t[RTT] as number));
    t[JITTER] = dev / HANDSHAKE_PINGS;
  }

  /**
   * How far ahead of a snapshot's tick an anchor puts the client: ceil(RTT / tick) + inputBuffer
   * + the adaptive lead.
   */
  leadTicks(inputBuffer: number): number {
    return Math.ceil((this.t[RTT] as number) / TICK_MS - 1e-9) + inputBuffer + this.adaptiveTicks;
  }

  /**
   * A frame gap made a hard resync that found the server `depth` ticks past the prediction (≤ 0:
   * the snapshot was too old instead): a dip to −depth. On `lan`, where the lead is all buffer, a
   * gap past it resyncs before any snapshot could show the dip, and the anchor restarts the
   * watch, so without this the clock would never learn the rhythm there. Like the dips, a pattern
   * counts: a second such resync within RESYNC_PATTERN_MS grows the adaptive lead at once by
   * enough to lift the deeper dip to `target`. A resync deeper than the cap is a stall no allowed
   * buffer would have covered, so it is left out. Only for frame gaps (ClientSim's call site): a
   * link outage that starved the server is not a frame rhythm.
   */
  onResync(depth: number, target: number): void {
    if (depth <= 0 || depth > MAX_ADAPTIVE_TICKS) return;
    const t = this.t;
    const now = this.now[0] as number;
    if (now - (t[LAST_RESYNC] as number) <= RESYNC_PATTERN_MS) {
      this.adaptiveTicks = Math.min(MAX_ADAPTIVE_TICKS, this.adaptiveTicks + depth + target);
    }
    t[LAST_RESYNC] = now;
  }

  /**
   * Restarts the buffer-health watch after the client jumped to a new tick: snapshots up to
   * `throughTick` were simulated before its cmds could arrive, so they are ignored.
   */
  anchor(throughTick: number): void {
    this.ignoreHealthThroughTick = throughTick;
    this.healthSamples = 0;
    this.windowHead = 0;
    this.windowCount = 0;
    this.windowSum = 0;
    // The new lead is measured from scratch: no speed to carry into it.
    this.dil[0] = 0;
  }

  /**
   * Skips the snapshots up to `throughTick` without restarting the watch: their health measures
   * a one-off stall of this client (ClientSim's hitch), not the rhythm the buffer is sized for.
   */
  skipHealthThrough(throughTick: number): void {
    if (throughTick > this.ignoreHealthThroughTick) this.ignoreHealthThroughTick = throughTick;
  }

  /**
   * Feeds one snapshot's input buffer health (an integer) and sets the dilation. Returns the step
   * the client should take now: k > 0 fast-forwards k ticks, k < 0 holds −k tick periods, 0 none.
   * `clientTick` is the client's newest predicted tick; snapshots up to the tick the step's effect
   * reaches are then ignored (δ stays as set), and the mean and the window move by the step at
   * once instead of waiting for them.
   */
  onSnapshotHealth(health: number, serverTick: number, clientTick: number, target: number): number {
    if (serverTick <= this.ignoreHealthThroughTick) return 0;
    const t = this.t;
    if (this.healthSamples === 0) t[HEALTH] = health;
    else t[HEALTH] = (t[HEALTH] as number) + (health - (t[HEALTH] as number)) * HEALTH_WEIGHT;
    // A floor sample counts as deepening: its depth is unknown.
    const deepening =
      this.healthSamples === 0 || health < this.lastHealth || health <= HEALTH_FLOOR;
    this.lastHealth = health;
    this.healthSamples++;
    this.pushHealth(health);
    const low = this.low;
    const full = this.windowCount === LOW_WINDOW;
    const average = this.windowSum / this.windowCount;
    if (full) {
      // The spread the clock keeps the mean above the target for: a lone dip (the mean still on
      // the target) or a round trip rounded up (no spread) is not one.
      const spread = Math.min(average - low, average - target);
      this.adaptiveTicks = Math.min(MAX_ADAPTIVE_TICKS, Math.max(0, Math.round(spread)));
    }
    let step = 0;
    if (low < target - LOW_MARGIN && !deepening && this.recurring(target - LOW_MARGIN)) {
      // To target − 1, as far as the cap allows; dilation closes the last tick.
      step = Math.min(
        target - LOW_MARGIN - low,
        MAX_FAST_FORWARD_TICKS,
        Math.floor(target + MAX_ADAPTIVE_TICKS - average),
      );
      if (step < 1) step = 0;
    } else if (full && low >= target + HOLD_ABOVE) {
      // The whole window that far above: a round trip that fell, a stall's lead.
      step = -Math.min(MAX_HOLD_TICKS, low - target - HOLD_TO);
    }
    if (step !== 0) {
      t[HEALTH] = (t[HEALTH] as number) + step;
      const w = this.recent;
      for (let i = 0; i < LOW_WINDOW; i++) w[i] = (w[i] as number) + step;
      this.windowSum += step * this.windowCount;
      this.low = low + step;
      this.lastHealth += step;
      this.ignoreHealthThroughTick = clientTick + Math.abs(step);
      this.adjustments++;
      if (step > 0) this.fastForwards++;
      else this.holds++;
    }
    this.lowFast = this.fastLow();
    t[AVERAGE] = this.windowSum / this.windowCount;
    this.dil[0] = 0;
    if (this.dilationOn) this.setDilation(target, full);
    return step;
  }

  /**
   * δ into `dil[0]` for the window as it stands (D-039, M3 design §2.7): the adaptive cap's excess
   * slows at the full DIL_MAX; else a fast low edge below the target speeds up by DIL_GAIN per
   * tick; else a full window whose low edge and mean are both a tick or more above slows down the
   * same way. The mean counts rounded for that: the EWMA approaches a health from below and can
   * stall a few ulps short of it for good, so a health settled at exactly target + 1 counts as 1
   * above. Doubles stay in slots (no fractional double crosses the call).
   */
  private setDilation(target: number, full: boolean): void {
    const t = this.t;
    const out = this.dil;
    if ((t[AVERAGE] as number) > target + MAX_ADAPTIVE_TICKS + CAP_EXCESS) {
      out[0] = -DIL_MAX;
      return;
    }
    const fast = this.lowFast - target;
    if (fast <= -SPEED_UP_DEADBAND) {
      out[0] = Math.min(DIL_MAX, -DIL_GAIN * fast);
      return;
    }
    const low = this.low;
    if (
      full &&
      low >= target + SLOW_DOWN_ABOVE &&
      Math.round(t[HEALTH] as number) >= target + SLOW_DOWN_ABOVE
    ) {
      out[0] = -Math.min(DIL_MAX, DIL_GAIN * (Math.min(low, t[HEALTH] as number) - target));
    }
  }

  /** The lowest of the newest LOW_FAST_WINDOW healths in the window. */
  private fastLow(): number {
    const w = this.recent;
    const n = Math.min(this.windowCount, LOW_FAST_WINDOW);
    let j = this.windowHead + this.windowCount - 1;
    if (j >= LOW_WINDOW) j -= LOW_WINDOW;
    let m = w[j] as number;
    for (let i = 1; i < n; i++) {
      j = j === 0 ? LOW_WINDOW - 1 : j - 1;
      m = Math.min(m, w[j] as number);
    }
    return m;
  }

  /**
   * Whether the window's dips below `margin` are a pattern rather than a one-off: at least
   * FAST_FORWARD_DIPS separate dips, or the newest one lasting FAST_FORWARD_RUN snapshots.
   */
  private recurring(margin: number): boolean {
    const w = this.recent;
    const n = this.windowCount;
    const start = n < LOW_WINDOW ? 0 : this.windowHead;
    let dips = 0;
    let run = 0;
    for (let i = 0; i < n; i++) {
      let j = start + i;
      if (j >= LOW_WINDOW) j -= LOW_WINDOW;
      if ((w[j] as number) < margin) {
        if (run === 0) dips++;
        run++;
      } else {
        run = 0;
      }
    }
    return dips >= FAST_FORWARD_DIPS || run >= FAST_FORWARD_RUN;
  }

  /** Adds a health to the window and updates the low edge (a rescan only when it leaves). */
  private pushHealth(health: number): void {
    const w = this.recent;
    this.windowSum += health;
    if (this.windowCount < LOW_WINDOW) {
      w[(this.windowHead + this.windowCount) % LOW_WINDOW] = health;
      this.low = this.windowCount === 0 ? health : Math.min(this.low, health);
      this.windowCount++;
      return;
    }
    const head = this.windowHead;
    const evicted = w[head] as number;
    this.windowSum -= evicted;
    w[head] = health;
    this.windowHead = head + 1 === LOW_WINDOW ? 0 : head + 1;
    if (health <= this.low) this.low = health;
    else if (evicted === this.low) {
      let m = health;
      for (let i = 0; i < LOW_WINDOW; i++) m = Math.min(m, w[i] as number);
      this.low = m;
    }
  }
}
