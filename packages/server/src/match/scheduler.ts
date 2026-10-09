import {
  type BitWriter,
  copySlot,
  ENTITY_DELTA_MAX_BITS,
  ENTITY_NEW_BITS,
  ENTITY_REMOVED_BITS,
  encodeSnapshot,
  entityRecordBits,
  FRAME_SLOTS,
  SNAP_BUDGET_BITS,
  SNAP_DEFERRED_COUNT_BITS,
  SNAP_DEFERRED_ID_BITS,
  SNAP_DELTA_FIXED_BITS,
  SNAP_FULL_FIXED_BITS,
  SNAP_REUSED_OUT_BITS,
  type SnapshotHeader,
  type WorldFrame,
} from "@game/shared";
import { baselineTick, markSent, markUnsent, type SentState, type WorldHistory } from "./history";
import { type ClientMirror, type MirrorPool, sentFrame } from "./mirror";

/**
 * The byte-budget scheduler (M3 design §2.3, D-046; `docs/05` §4.3's deferral, with the time since
 * a player's last update as the only priority in M3: distance and visibility join with relevance
 * in M9). Per client, per tick, it picks the other players a snapshot carries so it stays within
 * SNAP_BUDGET_BITS (1100 B), never leaving a player out two ticks in a row and never delaying a
 * removal:
 *
 * 1. **Worst-case check** (O(1), the bypass): W = 312 + 233 p + 17 r for a delta (p remotes present
 *    now, r slots the baseline holds, pending included, that are gone now), 292 + 213 p for a full
 *    snapshot. W ≤ 8800 bits: everything goes, no size pass, the frame is plain. That holds while
 *    baseline and current frame hold ≤ 37 players by id, so at the default 32 it always holds.
 * 2. **Size pass:** the exact bits of every record (`entityRecordBits`). If they fit, everything
 *    goes (the frame is still plain).
 * 3. **Selection:** removals (17 bits) always go. Every other record is reserved at its out cost,
 *    16 bits for a deferred id or 17 for a reused slot (a new player where the baseline still
 *    holds the one who left, which is sent as a removal when left out, so the departed player
 *    disappears on time and the new one is never drawn at their place). Then the records go in
 *    priority order while they fit, each adding its bits minus its out cost: staleness (ticks
 *    since the last snapshot that carried the player fresh) descending (a reused slot whose new
 *    player the client was already sent ranks just above the other staleness-1 records, so it
 *    does not blink out while the ack catches up), then the tick it was last
 *    left out descending (so the players left out longest ago go out next: update rates rotate),
 *    then id ascending; one that does not fit is left out and the scan goes on (first fit).
 *    Unchanged players cost nothing and are never left out.
 *
 * The bound (`SNAP_MIN_CAPACITY`, checked at load in `snapshot.ts`): at least 34 records fit any
 * delta snapshot (37 full), so at most 29 players are left out, and those are the only ones with
 * staleness 2 next tick: they sort first and always fit. A player left out of the snapshot of T
 * was carried fresh at T − 1, and is carried fresh at T + 1. If that ever failed (`overrun`, a
 * bug), the scan treats the stale ones like the rest and the match counts `sched_overrun`.
 *
 * Commit only on success: `schedule` writes the next `lastSent`/`lastDeferred`/`sentSerial` into
 * scratch rows; `commit` copies them once the snapshot encoded (`buildSnapshot`). Everything is
 * preallocated; no call allocates.
 */

// What `schedule` decided for each slot (`SnapshotScheduler.decision`).

/** No record and nothing to keep: absent now and in the baseline, or the receiver itself. */
export const SCHED_NONE = 0;
/** Present now and carried fresh: a record, or unchanged since the baseline. */
export const SCHED_FRESH = 1;
/** Gone since the baseline: a removal, never left out. */
export const SCHED_REMOVED = 2;
/** Left out: keeps the baseline's state and stamp, or is pending where the baseline has none. */
export const SCHED_DEFERRED = 3;
/** A reused slot left out: sent as a removal, absent in the client's frame until next tick. */
export const SCHED_DROPPED = 4;

/** What the scheduler keeps per client (`Session` implements it). */
export interface ScheduleState {
  /** Per slot: the last tick a sent snapshot carried the player fresh. */
  readonly lastSent: Int32Array;
  /** Per slot: the last tick a sent snapshot left the player out (0: never). */
  readonly lastDeferred: Int32Array;
  /** Per slot: the serial of the player the last sent snapshot saw there, −1 for none. */
  readonly sentSerial: Int32Array;
}

/** A client as `buildSnapshot` sees it: what it was sent, its scheduler rows, its mirror. */
export interface SnapshotClient extends SentState, ScheduleState {
  mirror: ClientMirror | null;
}

/** Fresh rows for a new client: nobody seen yet. */
export function resetScheduleState(s: ScheduleState): void {
  s.lastSent.fill(0);
  s.lastDeferred.fill(0);
  s.sentSerial.fill(-1);
}

/** Whether `f` holds state for slot `s` (present and not pending). */
function hasState(f: WorldFrame, s: number): boolean {
  return f.present[s] === 1 && f.stamp[s] !== 0;
}

/**
 * The worst-case size of a snapshot of `cur` (which holds its receiver) against `base` (null:
 * full), bits: every remote's record at its largest form, plus a removal per slot `base` holds
 * (pending included: the present mask covers pending slots) that `cur` lacks. O(1): popcounts of
 * the frames' masks.
 */
export function worstCaseBits(cur: WorldFrame, base: WorldFrame | null): number {
  const remotes = cur.presentCount - 1;
  if (base === null) return SNAP_FULL_FIXED_BITS + ENTITY_NEW_BITS * remotes;
  const removals = base.presentNotIn(cur);
  return SNAP_DELTA_FIXED_BITS + ENTITY_DELTA_MAX_BITS * remotes + ENTITY_REMOVED_BITS * removals;
}

export class SnapshotScheduler {
  /** Per slot: SCHED_* for the last `schedule`. */
  readonly decision = new Uint8Array(FRAME_SLOTS);
  /** The rows `commit` writes into the client. */
  readonly nextLastSent = new Int32Array(FRAME_SLOTS);
  readonly nextLastDeferred = new Int32Array(FRAME_SLOTS);
  readonly nextSerial = new Int32Array(FRAME_SLOTS);
  /** Of the last `schedule`: whether it ran the size pass. */
  sizePass = false;
  /** Players left out with a deferred id, and reused slots left out as removals. */
  deferred = 0;
  dropped = 0;
  /** A player with staleness ≥ 2 had to be left out (impossible by the bound; counted). */
  overrun = false;
  /** The largest staleness among the remotes present (1 every tick without deferral). */
  maxStaleness = 0;
  /** An upper bound of the snapshot's bits, as accounted (exact but for the local block). */
  bits = 0;

  private readonly recordBits = new Int32Array(FRAME_SLOTS);
  private readonly outBits = new Int32Array(FRAME_SLOTS);
  private readonly staleness = new Int32Array(FRAME_SLOTS);
  /** 2 × staleness, + 1 for a reused slot whose new player the client was already sent. */
  private readonly priority = new Int32Array(FRAME_SLOTS);
  /** Record slots in priority order (insertion-sorted). */
  private readonly order = new Int32Array(FRAME_SLOTS);

  /**
   * Decides which players the snapshot of `t` for receiver `selfId` carries, from world frame
   * `cur` against `base` (the frame the client holds for the baseline tick, null for a full
   * snapshot), and the next scheduler rows for `state`. True when nothing was left out: the
   * snapshot is encoded from `cur` itself (a plain frame); false when `writeMirror` must build the
   * client's frame first.
   */
  schedule(
    cur: WorldFrame,
    base: WorldFrame | null,
    selfId: number,
    t: number,
    state: ScheduleState,
  ): boolean {
    const decision = this.decision;
    this.sizePass = false;
    this.deferred = 0;
    this.dropped = 0;
    this.overrun = false;
    const worst = worstCaseBits(cur, base);
    if (worst <= SNAP_BUDGET_BITS) {
      this.bits = worst;
      this.allFresh(cur, base, selfId, t, state);
      return true;
    }
    this.sizePass = true;
    const recordBits = this.recordBits;
    let total = base === null ? SNAP_FULL_FIXED_BITS : SNAP_DELTA_FIXED_BITS;
    for (let s = 0; s < FRAME_SLOTS; s++) {
      const bits = s === selfId ? 0 : entityRecordBits(cur, base, s);
      recordBits[s] = bits;
      total += bits;
    }
    if (total <= SNAP_BUDGET_BITS) {
      this.bits = total;
      this.allFresh(cur, base, selfId, t, state);
      return true;
    }
    // Removals and every record's out cost reserved up front, then records by priority.
    const outBits = this.outBits;
    const staleness = this.staleness;
    const priority = this.priority;
    const order = this.order;
    const lastDeferred = state.lastDeferred;
    let used =
      (base === null ? SNAP_FULL_FIXED_BITS : SNAP_DELTA_FIXED_BITS) + SNAP_DEFERRED_COUNT_BITS;
    let n = 0;
    let maxStale = 0;
    for (let s = 0; s < FRAME_SLOTS; s++) {
      const bits = recordBits[s] as number;
      if (s === selfId || cur.present[s] !== 1) {
        decision[s] = bits > 0 ? SCHED_REMOVED : SCHED_NONE;
        used += bits;
        continue;
      }
      const stale = this.stalenessOf(cur, s, t, state);
      if (stale > maxStale) maxStale = stale;
      if (bits === 0) {
        decision[s] = SCHED_FRESH;
        continue;
      }
      const reused = base !== null && hasState(base, s) && base.serial[s] !== cur.serial[s];
      const out = reused ? SNAP_REUSED_OUT_BITS : SNAP_DEFERRED_ID_BITS;
      outBits[s] = out;
      staleness[s] = stale;
      // A reused slot whose new player this client was already sent (its ack still holds the old
      // one) would be dropped as a removal, a one-tick blink of a player it draws: it ranks just
      // below the due ones, above every other staleness-1 record (the bound is unchanged).
      const prio =
        2 * stale +
        (reused && (state.sentSerial[s] as number) === (cur.serial[s] as number) ? 1 : 0);
      priority[s] = prio;
      used += out;
      // Insertion by (priority desc, last left out desc, id asc); ids arrive ascending.
      const ld = lastDeferred[s] as number;
      let j = n - 1;
      while (j >= 0) {
        const o = order[j] as number;
        const op = priority[o] as number;
        if (op > prio || (op === prio && (lastDeferred[o] as number) >= ld)) break;
        order[j + 1] = o;
        j--;
      }
      order[j + 1] = s;
      n++;
    }
    for (let i = 0; i < n; i++) {
      const s = order[i] as number;
      const marginal = (recordBits[s] as number) - (outBits[s] as number);
      if (used + marginal <= SNAP_BUDGET_BITS) {
        used += marginal;
        decision[s] = SCHED_FRESH;
        continue;
      }
      if ((outBits[s] as number) === SNAP_REUSED_OUT_BITS) {
        decision[s] = SCHED_DROPPED;
        this.dropped++;
      } else {
        decision[s] = SCHED_DEFERRED;
        this.deferred++;
      }
      if ((staleness[s] as number) >= 2) this.overrun = true;
    }
    this.bits = this.deferred > 0 ? used : used - SNAP_DEFERRED_COUNT_BITS;
    this.maxStaleness = maxStale;
    this.nextRows(cur, selfId, t, state);
    return this.deferred === 0 && this.dropped === 0;
  }

  /**
   * The client's frame for the snapshot (after a `schedule` that returned false), into
   * `out`: the receiver's row and every fresh player from `cur`, a left-out player as `base`
   * holds it (row, serial and stamp) or pending, a dropped reused slot and every removal absent.
   */
  writeMirror(out: WorldFrame, cur: WorldFrame, base: WorldFrame | null, selfId: number): void {
    const decision = this.decision;
    out.clear();
    for (let s = 0; s < FRAME_SLOTS; s++) {
      const d = decision[s] as number;
      if (s === selfId || d === SCHED_FRESH) {
        copySlot(out, s, cur, s);
      } else if (d === SCHED_DEFERRED) {
        if (base !== null && hasState(base, s)) {
          copySlot(out, s, base, s);
        } else {
          copySlot(out, s, cur, s);
          out.setPresent(s, 0);
        }
      }
    }
  }

  /** Writes the rows `schedule` prepared into `state` (after the snapshot went out). */
  commit(state: ScheduleState): void {
    state.lastSent.set(this.nextLastSent);
    state.lastDeferred.set(this.nextLastDeferred);
    state.sentSerial.set(this.nextSerial);
  }

  /**
   * Ticks since the last snapshot that carried slot `s`'s player fresh; 1 for a player this
   * client has not seen yet (a join, or a new player in the slot), as if seen last tick.
   */
  private stalenessOf(cur: WorldFrame, s: number, t: number, state: ScheduleState): number {
    if ((state.sentSerial[s] as number) !== (cur.serial[s] as number)) return 1;
    return t - (state.lastSent[s] as number);
  }

  /** Every present player fresh (the bypass, or a size pass that fit). */
  private allFresh(
    cur: WorldFrame,
    base: WorldFrame | null,
    selfId: number,
    t: number,
    state: ScheduleState,
  ): void {
    const decision = this.decision;
    let maxStale = 0;
    for (let s = 0; s < FRAME_SLOTS; s++) {
      if (s === selfId) {
        decision[s] = SCHED_NONE;
        continue;
      }
      if (cur.present[s] !== 1) {
        decision[s] = base !== null && base.present[s] === 1 ? SCHED_REMOVED : SCHED_NONE;
        continue;
      }
      decision[s] = SCHED_FRESH;
      const stale = this.stalenessOf(cur, s, t, state);
      if (stale > maxStale) maxStale = stale;
    }
    this.maxStaleness = maxStale;
    this.nextRows(cur, selfId, t, state);
  }

  /** The rows after this snapshot, from `decision`. */
  private nextRows(cur: WorldFrame, selfId: number, t: number, state: ScheduleState): void {
    const decision = this.decision;
    const lastSent = this.nextLastSent;
    const lastDeferred = this.nextLastDeferred;
    const serial = this.nextSerial;
    for (let s = 0; s < FRAME_SLOTS; s++) {
      lastDeferred[s] = state.lastDeferred[s] as number;
      if (s === selfId || cur.present[s] !== 1) {
        lastSent[s] = state.lastSent[s] as number;
        serial[s] = -1;
        continue;
      }
      const d = decision[s] as number;
      const seen = (state.sentSerial[s] as number) === (cur.serial[s] as number);
      serial[s] = cur.serial[s] as number;
      if (d === SCHED_FRESH) {
        lastSent[s] = t;
      } else {
        // Left out: a player seen before keeps its last fresh tick; a new one counts as seen at
        // t − 1, so it is due (staleness 2) next tick.
        lastSent[s] = seen ? (state.lastSent[s] as number) : t - 1;
        lastDeferred[s] = t;
      }
    }
  }
}

/**
 * Encodes the snapshot of `t` for `client` (receiver `selfId`) into `w` (M3 design §2.3, §2.5
 * step 7): the baseline (`baselineTick`), the frame the client holds for it (`sentFrame`), the
 * scheduler, the client's mirror frame of `t` when players were left out (taken from `pool` if
 * the client has none, a safety net: a session of a match above 37 players gets one at connect),
 * then the encode. `hdr`'s flags, cvarHash and inputBufferHealth are the caller's; the tick and
 * baseBack are set here. Only a successful encode counts: the tick is marked sent, a mirror frame
 * kept and the scheduler rows committed. A failed one (impossible by the bound) marks the tick
 * unsent and changes nothing else; the caller counts `snapshot_overflow`. History must hold `t`.
 */
export function buildSnapshot(
  sched: SnapshotScheduler,
  w: BitWriter,
  hdr: SnapshotHeader,
  history: WorldHistory,
  client: SnapshotClient,
  selfId: number,
  t: number,
  pool: MirrorPool | null,
): boolean {
  const b = baselineTick(client, t, history);
  hdr.serverTick = t;
  hdr.baseBack = b === 0 ? 0 : t - b;
  const cur = history.frameFor(t);
  const base = b === 0 ? null : sentFrame(history, client.mirror, b);
  const plain = sched.schedule(cur, base, selfId, t, client);
  let frame = cur;
  let mirror = client.mirror;
  if (!plain) {
    if (mirror === null && pool !== null) {
      mirror = pool.acquire();
      client.mirror = mirror;
    }
    if (mirror === null) {
      markUnsent(client, t);
      return false;
    }
    const ring = mirror.ring;
    // Its index held tick t − 64 (or an older one), out of every baseline's reach.
    ring.invalidate(ring.tickAt(t));
    frame = ring.slot(t);
    sched.writeMirror(frame, cur, base, selfId);
  }
  w.reset();
  if (!encodeSnapshot(w, hdr, frame, base, selfId)) {
    markUnsent(client, t);
    return false;
  }
  markSent(client, t);
  if (!plain && mirror !== null) mirror.ring.store(t);
  sched.commit(client);
  return true;
}
