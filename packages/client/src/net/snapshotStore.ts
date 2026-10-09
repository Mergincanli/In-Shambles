import {
  type BitReader,
  decodeSnapshotBody,
  decodeSnapshotHeader,
  FrameRing,
  SNAP_FLAG_SPECTATOR,
  SnapshotHeader,
  WorldFrame,
} from "@game/shared";

/** What `SnapshotStore.receive` did with a SNAPSHOT. */
/** Decoded and stored as its tick's frame: `header` and `lastStored` hold it. */
export const STORE_STORED = 0;
/** Valid header, but its tick's ring slot already holds that tick or a newer one: dropped. */
export const STORE_STALE = 1;
/** It did not decode: the caller strikes it. */
export const STORE_BAD = 2;
/** A spectator snapshot (demo files only, D-044): a live connection drops and strikes it. */
export const STORE_SPECTATOR = 3;
/**
 * A delta whose baseline frame the store no longer (or never) held: dropped, not struck (D-038).
 * The server encoded it against a tick the client acked, so this is loss or a ring overwrite, not
 * a bad packet.
 */
export const STORE_NO_BASELINE = 4;

/**
 * Missing baselines in a row after which the store acks 0, asking for a full snapshot, until one
 * arrives (M3 design §2.3, design value): a safety net; with 64-frame rings on both ends a delta's
 * baseline is always one the client stored.
 */
export const BASELINE_MISSES_BEFORE_FULL = 8;

/**
 * The client's snapshot store (M3 design §2.3, D-033, D-038): the last 64 frames by tick, as the
 * receiver holds them. A delta is decoded against the stored frame of its baseline tick
 * (serverTick − baseBack); without that frame it is dropped, and after
 * BASELINE_MISSES_BEFORE_FULL such drops in a row the ack is 0 until a full snapshot arrives. A
 * snapshot is decoded only when it is newer than what its tick's slot holds, straight into a spare
 * frame that is then swapped into the ring, so nothing is copied or allocated; one that fails to
 * decode leaves the store as it was. By induction every stored frame equals the frame the server
 * encoded it from (frameDigest). Prediction reads the local slot of the newest
 * (`slotToPlayerState`); the interpolator (D-037) reads the other slots of all.
 */
export class SnapshotStore {
  readonly ring = new FrameRing();
  /** The header of the last snapshot `receive` read (valid after STORED, STALE or NO_BASELINE). */
  readonly header = new SnapshotHeader();
  /** The newest tick stored, 0 before the first. */
  newestTick = 0;
  /** Snapshots stored, and of those the full ones and the deltas. */
  stored = 0;
  full = 0;
  delta = 0;
  /** Valid snapshots not stored: a duplicate, or older than what their slot holds. */
  stale = 0;
  /** Deltas dropped because their baseline frame was not held (STAT_BASELINE_DROPS). */
  baselineDrops = 0;
  /** Spectator snapshots refused (a live connection never gets one from an honest server). */
  spectatorDropped = 0;
  /** Snapshots that did not decode. */
  bad = 0;
  /** Baseline misses since the last stored snapshot. */
  private missRun = 0;
  /** Set after BASELINE_MISSES_BEFORE_FULL misses in a row; cleared by a stored full snapshot. */
  private wantFull = false;
  private spare = new WorldFrame();
  private latest: WorldFrame | null = null;

  /**
   * The frame of the snapshot last stored (the receiver's view of that tick), or null. After a
   * reordered older snapshot this is that older tick: what `receive` just stored, not the newest.
   */
  get lastStored(): WorldFrame | null {
    return this.latest;
  }

  /** The frame of `newestTick`, or null before the first (the current world as last seen). */
  get newest(): WorldFrame | null {
    return this.ring.get(this.newestTick);
  }

  /**
   * What INPUT acks (`lastSnapshotTick`, D-038): the newest stored tick, the baseline the server
   * should code against; 0 ("send a full snapshot") before the first and while the missing-baseline
   * safety net asks for a full one.
   */
  get ackTick(): number {
    return this.wantFull ? 0 : this.newestTick;
  }

  /**
   * Decodes the SNAPSHOT in `r` as receiver `selfId` and stores it; returns a STORE_* code. The
   * header is read first, so a spectator, stale or baseline-less snapshot is dropped before its
   * body is parsed.
   */
  receive(r: BitReader, selfId: number): number {
    const h = this.header;
    if (!decodeSnapshotHeader(r, h)) {
      this.bad++;
      return STORE_BAD;
    }
    if ((h.flags & SNAP_FLAG_SPECTATOR) !== 0) {
      this.spectatorDropped++;
      return STORE_SPECTATOR;
    }
    const t = h.serverTick;
    const ring = this.ring;
    if (ring.tickAt(t) >= t) {
      this.stale++;
      return STORE_STALE;
    }
    let base: WorldFrame | null = null;
    if (h.baseBack !== 0) {
      base = ring.get(t - h.baseBack);
      if (base === null) {
        this.baselineDrops++;
        if (++this.missRun >= BASELINE_MISSES_BEFORE_FULL) this.wantFull = true;
        return STORE_NO_BASELINE;
      }
    }
    const f = this.spare;
    if (!decodeSnapshotBody(r, h, base, selfId, f)) {
      this.bad++;
      return STORE_BAD;
    }
    this.spare = ring.swapIn(t, f);
    this.latest = f;
    if (t > this.newestTick) this.newestTick = t;
    this.stored++;
    this.missRun = 0;
    if (base === null) {
      this.full++;
      this.wantFull = false;
    } else {
      this.delta++;
    }
    return STORE_STORED;
  }

  /** Forgets every frame (a new session). */
  reset(): void {
    this.ring.clear();
    this.newestTick = 0;
    this.latest = null;
    this.missRun = 0;
    this.wantFull = false;
  }
}
