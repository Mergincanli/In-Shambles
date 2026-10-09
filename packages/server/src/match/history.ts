import { FrameRing, SNAPSHOT_HISTORY, type WorldFrame } from "@game/shared";

const RING_MASK = SNAPSHOT_HISTORY - 1;

/**
 * The match's world frames of the last SNAPSHOT_HISTORY ticks (M3 design §2.3, D-038): one ring
 * for every client, captured once at the end of each tick. A client's delta is coded against the
 * frame of the tick it acked, so the baseline is exactly what the server sent then; up to 37
 * players (D-034) every sent frame is the world frame minus the receiver's row, so nothing per
 * client is stored but the sent ring.
 */
export class WorldHistory {
  readonly ring = new FrameRing();

  /** The frame object tick `t` is captured into; it is `t`'s once `stored(t)` marks it. */
  frameFor(t: number): WorldFrame {
    return this.ring.slot(t);
  }

  /** Marks the frame `frameFor(t)` returned as tick `t`'s (it drops tick t − 64). */
  stored(t: number): void {
    this.ring.store(t);
  }

  /** Tick `t`'s frame, or null when it is not held (never captured, or older than 63 ticks). */
  get(t: number): WorldFrame | null {
    return this.ring.get(t);
  }

  has(t: number): boolean {
    return this.ring.has(t);
  }

  /** Forgets every frame. */
  clear(): void {
    this.ring.clear();
  }
}

// What a client's ack did (`acceptAck`).

/** Ack 0: the client asks for a full snapshot; the baseline is dropped. */
export const ACK_FULL = 0;
/** A valid ack: the baseline is the newest valid one acked so far. */
export const ACK_TAKEN = 1;
/** Older than the baseline, out of the window, never sent or no longer held: ignored. */
export const ACK_IGNORED = 2;
/** Past the newest snapshot sent: ignored and struck (+2; M3 design §2.3). */
export const ACK_AHEAD = 3;

/** Strikes an ack past the newest snapshot sent costs (M3 design §2.3, design value). */
export const ACK_AHEAD_STRIKES = 2;

/**
 * One client's view of the snapshots sent to it (M3 design §2.3, D-038): the ticks of the last 64
 * sent (index `tick & 63`, 0 for a slot whose tick was never sent or whose encode failed), the
 * newest of them and the acked baseline. `Session` implements it; the rules are free functions so
 * that NET-02's world-sequence driver runs this exact code.
 */
export interface SentState {
  readonly sentTicks: Int32Array;
  newestSent: number;
  /** The newest valid tick the client acked, 0 for none (a full snapshot). */
  ackTick: number;
}

/**
 * Whether tick `b`'s frame can be the baseline of a snapshot of `t`: 0 < b < t, at most 63 ticks
 * back, sent to this client (not overwritten in its ring, not a failed encode) and still held.
 */
function usable(s: SentState, b: number, t: number, history: WorldHistory): boolean {
  return b > 0 && b < t && t - b <= RING_MASK && s.sentTicks[b & RING_MASK] === b && history.has(b);
}

/**
 * Applies an INPUT's `lastSnapshotTick` during tick `t` (the tick about to be simulated) and
 * returns an ACK_* code. 0 asks for a full snapshot; an ack past the newest snapshot sent is
 * hostile (struck by the caller); one that is not usable is ignored; a usable one raises the
 * baseline, never lowers it (a reordered INPUT carries an older ack).
 */
export function acceptAck(s: SentState, ack: number, t: number, history: WorldHistory): number {
  if (ack === 0) {
    s.ackTick = 0;
    return ACK_FULL;
  }
  if (ack > s.newestSent) return ACK_AHEAD;
  if (ack <= s.ackTick || !usable(s, ack, t, history)) return ACK_IGNORED;
  s.ackTick = ack;
  return ACK_TAKEN;
}

/**
 * The baseline tick for the snapshot of `t` (after the frame of `t` was captured): the acked tick
 * while it is usable, else 0 (a full snapshot). Whenever it is not 0 the snapshot's baseBack is
 * t − ackTick (NET-02).
 */
export function baselineTick(s: SentState, t: number, history: WorldHistory): number {
  const a = s.ackTick;
  return usable(s, a, t, history) ? a : 0;
}

/** Records that the snapshot of `t` went out: it can be acked and become a baseline. */
export function markSent(s: SentState, t: number): void {
  s.sentTicks[t & RING_MASK] = t;
  if (t > s.newestSent) s.newestSent = t;
}

/**
 * Records that no snapshot of `t` went out (its encode failed): its slot no longer names an
 * older tick, so neither `t` nor tick t − 64 can be acked or used as a baseline.
 */
export function markUnsent(s: SentState, t: number): void {
  s.sentTicks[t & RING_MASK] = 0;
}
