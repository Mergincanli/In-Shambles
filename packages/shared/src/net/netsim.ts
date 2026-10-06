import { DEV_ASSERT } from "../debug/assert";
import { Mulberry32 } from "../rng/mulberry32";
import { TICK_RATE } from "../time";
import { PACKET_CLOSE, PACKET_RELIABLE, PacketQueue } from "./packetQueue";
import { NET_PROFILE_LAN, type NetProfile } from "./profiles";
import {
  type CloseHandler,
  type MessageHandler,
  type Transport,
  TransportStats,
  validPacketLength,
} from "./transport";

/**
 * The net simulator (docs/05 §3.1, §13; D-028). It wraps the client's end of a connection and
 * delays both directions by the profile's one-way delay, so the round trip is twice it.
 *
 * - Unreliable packets: each is lost, reordered and duplicated by independent draws. A kept packet
 *   is due at max(previous due, now + delay ± jitter), so jitter alone never reorders (FIFO). A
 *   reordered one is held a further 2 × jitter + one tick past that and does not hold back the
 *   packets behind it, which overtake it. A duplicate follows its original through the FIFO rule.
 * - Reliable packets are delayed the same way, in order, never lost or duplicated.
 * - A close travels like a reliable packet, behind everything sent before it (a reordered
 *   unreliable packet still held then is lost). `close()` is graceful: what this side sent first
 *   still goes out once due, then the inner transport closes, so the peer sees the bare
 *   transport's close contract, only delayed.
 * - Sends go out through `pump()`, which every send and `poll()` run; `wake(at)` asks the host to
 *   call `pump()` at `at` (a browser arms a timer), so a packet leaves when it is due even between
 *   polls. Arrivals are taken from the inner transport by `poll()` and delivered by it once due.
 *
 * Times are milliseconds from the injected monotonic `clock`; the draws come from Mulberry32 with
 * a fixed count per packet, so one seed and one send/poll schedule give one delivery schedule.
 * Packets in flight are pooled copies: after warm-up nothing is allocated per packet.
 */

/** The reorder hold's "one tick" (a design constant, D-028). */
const TICK_MS = 1000 / TICK_RATE;

// Slots of `t`, the simulator's times in ms.
const NOW = 0;
const DUE = 1;
const LAST_OUT_UNRELIABLE = 2;
const LAST_OUT_RELIABLE = 3;
const LAST_IN_UNRELIABLE = 4;
const LAST_IN_RELIABLE = 5;
const LAST_WAKE = 6;
const FRONT = 7;

// Slots of `p`, the current profile.
const DELAY = 0;
const JITTER = 1;
const LOSS = 2;
const DUPLICATE = 3;
const REORDER = 4;

// Slots of `r`, one packet's draws.
const R_LOSS = 0;
const R_REORDER = 1;
const R_DUPLICATE = 2;
const R_JITTER = 3;
const R_JITTER_COPY = 4;
const DRAWS_UNRELIABLE = 5;

/** The payload of the close marker (it carries no bytes). */
const NO_BYTES = new Uint8Array(0);

function ignoreMessage(_d: Uint8Array, _len: number, _reliable: boolean): void {}
function ignoreClose(_reason: string): void {}

export class NetSimTransport implements Transport {
  private readonly inner: Transport;
  private readonly clock: () => number;
  private readonly wake: ((at: number) => void) | undefined;
  private readonly rng: Mulberry32;
  private readonly outbound = new PacketQueue();
  private readonly inbound = new PacketQueue();
  private readonly t = new Float64Array(8);
  private readonly p = new Float64Array(5);
  private readonly r = new Float64Array(DRAWS_UNRELIABLE);
  private readonly counters = new TransportStats();
  /** Replaced only by an accepted profile, so it always names the parameters in `p`. */
  private current: NetProfile = NET_PROFILE_LAN;
  private messageCb: MessageHandler = ignoreMessage;
  private closeCb: CloseHandler = ignoreClose;
  private open = true;
  /** Closed here, with outbound packets and the close marker still to forward. */
  private draining = false;
  /** The peer's close reason, delivered when its marker comes due. */
  private closeReason = "";
  /** This side's close reason, passed to the inner transport when its marker comes due. */
  private outCloseReason = "";

  constructor(
    inner: Transport,
    profile: NetProfile,
    clock: () => number,
    seed: number,
    wake?: (at: number) => void,
  ) {
    this.inner = inner;
    this.clock = clock;
    this.wake = wake;
    this.rng = new Mulberry32(seed);
    this.setProfile(profile);
    const t = this.t;
    t[LAST_OUT_UNRELIABLE] = Number.NEGATIVE_INFINITY;
    t[LAST_OUT_RELIABLE] = Number.NEGATIVE_INFINITY;
    t[LAST_IN_UNRELIABLE] = Number.NEGATIVE_INFINITY;
    t[LAST_IN_RELIABLE] = Number.NEGATIVE_INFINITY;
    t[LAST_WAKE] = Number.NaN;
    inner.onMessage((d, len, reliable) => this.arrive(d, len, reliable));
    inner.onClose((reason) => this.arriveClose(reason));
  }

  /**
   * Applies to packets sent or arriving from now on (`net_profile`). Packets in flight keep their
   * due times, and new ones still queue behind them.
   */
  setProfile(profile: NetProfile): void {
    const ok =
      profile.delayMs >= 0 &&
      profile.jitterMs >= 0 &&
      Number.isFinite(profile.delayMs + profile.jitterMs) &&
      isProbability(profile.loss) &&
      isProbability(profile.duplicate) &&
      isProbability(profile.reorder);
    if (!ok) {
      DEV_ASSERT(false, "net profile values out of range", profile.name);
      return;
    }
    this.current = profile;
    const p = this.p;
    p[DELAY] = profile.delayMs;
    p[JITTER] = profile.jitterMs;
    p[LOSS] = profile.loss;
    p[DUPLICATE] = profile.duplicate;
    p[REORDER] = profile.reorder;
  }

  profile(): NetProfile {
    return this.current;
  }

  sendUnreliable(d: Uint8Array, len: number): void {
    this.send(d, len, false);
  }

  sendReliable(d: Uint8Array, len: number): void {
    this.send(d, len, true);
  }

  onMessage(cb: MessageHandler): void {
    this.messageCb = cb;
  }

  onClose(cb: CloseHandler): void {
    this.closeCb = cb;
  }

  /**
   * Forwards every outbound packet that is due to the inner transport: the host's answer to
   * `wake`. It re-reports a front that is still pending, so a pump that comes early (a browser
   * timer truncates its fractional delay) asks again instead of stranding the packet.
   */
  pump(): void {
    if (!this.open && !this.draining) return;
    this.t[LAST_WAKE] = Number.NaN;
    this.forward();
  }

  /**
   * Pumps, takes the inner transport's arrivals, then delivers the arrivals that are due. After
   * `close()` it only forwards what is still held.
   */
  poll(): void {
    if (!this.open) {
      if (this.draining) this.forward();
      return;
    }
    const t = this.t;
    t[NOW] = this.clock();
    this.forwardDue();
    this.inner.poll();
    const q = this.inbound;
    while (this.open && q.dueBy(t, NOW)) {
      const id = q.take();
      const flags = q.flagsOf(id);
      if ((flags & PACKET_CLOSE) !== 0) {
        q.release(id);
        this.end();
        this.closeCb(this.closeReason);
        return;
      }
      const len = q.lengthOf(id);
      this.counters.delivered++;
      this.counters.deliveredBytes += len;
      this.messageCb(q.bytesOf(id), len, (flags & PACKET_RELIABLE) !== 0);
      q.release(id);
    }
    this.armWake();
  }

  /**
   * Graceful, like the bare transport's close: later sends and arrivals are dropped, but the
   * packets already sent still go out when due (through `pump()`, `poll()` or a wake), and the
   * inner transport closes behind them after the one-way delay.
   */
  close(reason = ""): void {
    if (!this.open) return;
    this.open = false;
    this.draining = true;
    this.outCloseReason = reason;
    this.inbound.clear();
    const t = this.t;
    t[NOW] = this.clock();
    t[LAST_OUT_RELIABLE] = Math.max(
      t[LAST_OUT_RELIABLE] as number,
      t[LAST_OUT_UNRELIABLE] as number,
    );
    this.schedule(this.outbound, NO_BYTES, 0, LAST_OUT_RELIABLE, PACKET_CLOSE);
    this.forwardDue();
    this.armWake();
  }

  isOpen(): boolean {
    return this.open;
  }

  stats(): TransportStats {
    return this.counters;
  }

  /** Packets held in either direction (tests and the netgraph). */
  inFlight(): number {
    return this.outbound.length + this.inbound.length;
  }

  private send(d: Uint8Array, len: number, reliable: boolean): void {
    if (!this.open || !validPacketLength(d, len, reliable)) return;
    this.counters.sent++;
    this.counters.sentBytes += len;
    this.t[NOW] = this.clock();
    if (reliable) this.schedule(this.outbound, d, len, LAST_OUT_RELIABLE, PACKET_RELIABLE);
    else this.scheduleUnreliable(this.outbound, d, len, LAST_OUT_UNRELIABLE);
    this.forwardDue();
    this.armWake();
  }

  /** An arrival from the inner transport, during `poll()` (so `t[NOW]` is current). */
  private arrive(d: Uint8Array, len: number, reliable: boolean): void {
    if (!this.open) return;
    if (reliable) this.schedule(this.inbound, d, len, LAST_IN_RELIABLE, PACKET_RELIABLE);
    else this.scheduleUnreliable(this.inbound, d, len, LAST_IN_UNRELIABLE);
  }

  /** The peer closed: its close arrives like a reliable packet, behind what it sent first. */
  private arriveClose(reason: string): void {
    if (!this.open) return;
    this.closeReason = reason;
    const t = this.t;
    t[LAST_IN_RELIABLE] = Math.max(t[LAST_IN_RELIABLE] as number, t[LAST_IN_UNRELIABLE] as number);
    this.schedule(this.inbound, NO_BYTES, 0, LAST_IN_RELIABLE, PACKET_CLOSE);
  }

  /** Reliable channel: delayed with jitter, kept in order, never dropped. */
  private schedule(q: PacketQueue, d: Uint8Array, len: number, last: number, flags: number): void {
    const t = this.t;
    const p = this.p;
    const r = this.r;
    this.rng.fillFloats(r, R_JITTER, 1);
    const jitter = ((r[R_JITTER] as number) * 2 - 1) * (p[JITTER] as number);
    const delay = Math.max(0, (p[DELAY] as number) + jitter);
    t[DUE] = Math.max(t[last] as number, (t[NOW] as number) + delay);
    t[last] = t[DUE] as number;
    q.push(d, len, flags, t, DUE);
  }

  private scheduleUnreliable(q: PacketQueue, d: Uint8Array, len: number, last: number): void {
    const t = this.t;
    const p = this.p;
    const r = this.r;
    this.rng.fillFloats(r, 0, DRAWS_UNRELIABLE);
    if ((r[R_LOSS] as number) < (p[LOSS] as number)) {
      this.counters.lost++;
      return;
    }
    const now = t[NOW] as number;
    const jitter = p[JITTER] as number;
    const delay = Math.max(0, (p[DELAY] as number) + ((r[R_JITTER] as number) * 2 - 1) * jitter);
    const fifo = Math.max(t[last] as number, now + delay);
    if ((r[R_REORDER] as number) < (p[REORDER] as number)) {
      this.counters.reordered++;
      t[DUE] = fifo + 2 * jitter + TICK_MS;
    } else {
      t[DUE] = fifo;
      t[last] = fifo;
    }
    q.push(d, len, 0, t, DUE);
    if ((r[R_DUPLICATE] as number) < (p[DUPLICATE] as number)) {
      this.counters.duplicated++;
      const copyJitter = ((r[R_JITTER_COPY] as number) * 2 - 1) * jitter;
      const copyDelay = Math.max(0, (p[DELAY] as number) + copyJitter);
      t[DUE] = Math.max(t[last] as number, now + copyDelay);
      t[last] = t[DUE] as number;
      q.push(d, len, 0, t, DUE);
    }
  }

  private forward(): void {
    this.t[NOW] = this.clock();
    this.forwardDue();
    this.armWake();
  }

  private forwardDue(): void {
    const q = this.outbound;
    const inner = this.inner;
    while ((this.open || this.draining) && q.dueBy(this.t, NOW)) {
      const id = q.take();
      const flags = q.flagsOf(id);
      if ((flags & PACKET_CLOSE) !== 0) {
        q.release(id);
        this.draining = false;
        q.clear();
        inner.close(this.outCloseReason);
        return;
      }
      if ((flags & PACKET_RELIABLE) !== 0) inner.sendReliable(q.bytesOf(id), q.lengthOf(id));
      else inner.sendUnreliable(q.bytesOf(id), q.lengthOf(id));
      q.release(id);
    }
  }

  /**
   * Tells the host when the next outbound packet is due, once per new due time (sends and polls
   * that leave the front unchanged report nothing; `pump()` re-reports it).
   */
  private armWake(): void {
    const wake = this.wake;
    if (wake === undefined) return;
    const t = this.t;
    if (!this.outbound.frontDue(t, FRONT)) {
      t[LAST_WAKE] = Number.NaN;
      return;
    }
    if (t[FRONT] === t[LAST_WAKE]) return;
    t[LAST_WAKE] = t[FRONT] as number;
    wake(t[FRONT] as number);
  }

  private end(): void {
    this.open = false;
    this.draining = false;
    this.outbound.clear();
    this.inbound.clear();
  }
}

function isProbability(x: number): boolean {
  return x >= 0 && x <= 1;
}
