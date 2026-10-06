import { TICK_RATE } from "@game/shared";

/**
 * The client clock of M2 (docs/05 §1.3, §8.2–§8.3; M2 design §2 "Client clock"; D-028). The
 * client predicts in server-tick space: its tick T is the server's tick T, and it runs ahead of
 * the server by the round trip plus an input buffer, so that the cmd for T reaches the server just
 * before the server simulates T.
 *
 * - **Handshake:** pings every HANDSHAKE_PING_SPACING_MS from WELCOME on, until five pongs have
 *   come back; their median is the round trip. At the first snapshot A the client jumps to tick
 *   A + ceil(RTT / tick) + cl_inputBuffer (`leadTicks`).
 * - **Ongoing:** a ping a second feeds EWMAs of the round trip and its jitter. Each snapshot's
 *   `inputBufferHealth` feeds an EWMA over about 30 snapshots. Below target − 1.5 for 0.5 s the
 *   clock asks for a fast-forward of k ticks (predicted and sent at once); above target + 3 for
 *   1 s, for a hold of k tick periods. Each step is a clock adjustment in the netgraph.
 *
 * A fast-forward's skip is hidden by the render offset; a hold shows as a short slowdown of the
 * drawn player (up to k ticks). Smooth time dilation (±3%, docs/05 §8.2) is NET-07 in M3. The
 * constants below are design values, not tunables. Time comes from the caller's clock slot
 * `now[0]` (ms).
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
/** Fast-forward when the health EWMA stays below target − this … */
const FAST_FORWARD_BELOW = 1.5;
/** … for this long (ms). */
const FAST_FORWARD_AFTER_MS = 500;
/** Hold when the health EWMA stays above target + this … */
const HOLD_ABOVE = 3;
/** … for this long (ms). */
const HOLD_AFTER_MS = 1000;
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
const BELOW_SINCE = 3;
const ABOVE_SINCE = 4;
const LAST_PING = 5;
const SCRATCH = 6;

export class ClientClock {
  /** [rtt ms, jitter ms, health EWMA, below since, above since, last ping sent, scratch]. */
  private readonly t = new Float64Array(7);
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

  constructor(private readonly now: Float64Array) {
    this.reset();
  }

  reset(): void {
    const t = this.t;
    t.fill(0);
    t[BELOW_SINCE] = Number.NaN;
    t[ABOVE_SINCE] = Number.NaN;
    t[LAST_PING] = Number.NEGATIVE_INFINITY;
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

  /** How far ahead of a snapshot's tick the client predicts: ceil(RTT / tick) + inputBuffer. */
  leadTicks(inputBuffer: number): number {
    return Math.ceil((this.t[RTT] as number) / TICK_MS - 1e-9) + inputBuffer;
  }

  /**
   * Restarts the buffer-health watch after the client jumped to a new tick: snapshots up to
   * `throughTick` were simulated before its cmds could arrive, so they are ignored.
   */
  anchor(throughTick: number): void {
    this.ignoreHealthThroughTick = throughTick;
    this.healthSamples = 0;
    this.t[BELOW_SINCE] = Number.NaN;
    this.t[ABOVE_SINCE] = Number.NaN;
  }

  /**
   * Feeds one snapshot's input buffer health (an integer). Returns the step the client should
   * take now: k > 0 fast-forwards k ticks, k < 0 holds −k tick periods, 0 none. `clientTick` is
   * the client's newest predicted tick; snapshots up to the tick the step's effect reaches are
   * then ignored, and the EWMA moves by the step at once instead of waiting for them.
   */
  onSnapshotHealth(health: number, serverTick: number, clientTick: number, target: number): number {
    if (serverTick <= this.ignoreHealthThroughTick) return 0;
    const t = this.t;
    if (this.healthSamples === 0) t[HEALTH] = health;
    else t[HEALTH] = (t[HEALTH] as number) + (health - (t[HEALTH] as number)) * HEALTH_WEIGHT;
    this.healthSamples++;
    const now = this.now[0] as number;
    let step = 0;
    if ((t[HEALTH] as number) < target - FAST_FORWARD_BELOW) {
      if (Number.isNaN(t[BELOW_SINCE] as number)) t[BELOW_SINCE] = now;
      else if (now - (t[BELOW_SINCE] as number) >= FAST_FORWARD_AFTER_MS) {
        step = Math.min(
          MAX_FAST_FORWARD_TICKS,
          Math.max(1, Math.round(target - (t[HEALTH] as number))),
        );
      }
    } else {
      t[BELOW_SINCE] = Number.NaN;
    }
    if ((t[HEALTH] as number) > target + HOLD_ABOVE) {
      if (Number.isNaN(t[ABOVE_SINCE] as number)) t[ABOVE_SINCE] = now;
      else if (now - (t[ABOVE_SINCE] as number) >= HOLD_AFTER_MS) {
        step = -Math.min(MAX_HOLD_TICKS, Math.max(1, Math.round((t[HEALTH] as number) - target)));
      }
    } else {
      t[ABOVE_SINCE] = Number.NaN;
    }
    if (step !== 0) {
      t[HEALTH] = (t[HEALTH] as number) + step;
      this.ignoreHealthThroughTick = clientTick + Math.abs(step);
      t[BELOW_SINCE] = Number.NaN;
      t[ABOVE_SINCE] = Number.NaN;
      this.adjustments++;
      if (step > 0) this.fastForwards++;
      else this.holds++;
    }
    return step;
  }
}
