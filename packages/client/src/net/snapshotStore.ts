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
/** Valid, but its tick's ring slot already holds that tick or a newer one: nothing changed. */
export const STORE_STALE = 1;
/** It did not decode: the caller strikes it. */
export const STORE_BAD = 2;
/** A spectator snapshot (demo files only, D-044): a live connection drops and strikes it. */
export const STORE_SPECTATOR = 3;

/**
 * The client's snapshot store (M3 design §2.3, D-033): the last 64 frames by tick, as the
 * receiver holds them, decoded straight into a spare frame that is then swapped into the ring, so
 * nothing is copied or allocated. A snapshot is stored only when it is newer than what its tick's
 * slot holds; one that fails to decode leaves the store as it was. Prediction reads the local slot
 * of the newest (`slotToPlayerState`); the interpolator (D-037) reads the other slots of all.
 *
 * Every snapshot is full until deltas (D-038): baselines, the missing-baseline drop rule and the ack
 * of the newest stored tick join then.
 */
export class SnapshotStore {
  readonly ring = new FrameRing();
  /** The header of the last snapshot `receive` decoded (valid after STORE_STORED or STORE_STALE). */
  readonly header = new SnapshotHeader();
  /** The newest tick stored, 0 before the first. */
  newestTick = 0;
  /** Snapshots stored, full ones (all of them until D-038). */
  stored = 0;
  full = 0;
  /** Valid snapshots not stored: a duplicate, or older than what their slot holds. */
  stale = 0;
  /** Spectator snapshots refused (a live connection never gets one from an honest server). */
  spectatorDropped = 0;
  /** Snapshots that did not decode. */
  bad = 0;
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
   * Decodes the SNAPSHOT in `r` as receiver `selfId` and stores it; returns a STORE_* code. The
   * header is read first, so a spectator snapshot is refused before its body is parsed.
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
    const f = this.spare;
    if (!decodeSnapshotBody(r, h, null, selfId, f)) {
      this.bad++;
      return STORE_BAD;
    }
    const t = h.serverTick;
    const ring = this.ring;
    if (ring.tickAt(t) >= t) {
      this.stale++;
      return STORE_STALE;
    }
    this.spare = ring.swapIn(t, f);
    this.latest = f;
    if (t > this.newestTick) this.newestTick = t;
    this.stored++;
    this.full++;
    return STORE_STORED;
  }

  /** Forgets every frame (a new session). */
  reset(): void {
    this.ring.clear();
    this.newestTick = 0;
    this.latest = null;
  }
}
