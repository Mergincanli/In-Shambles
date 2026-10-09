import { BitReader, type WorldFrame } from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  DELTA_SELF,
  type DeltaStore,
  runDeltaSequence,
} from "../../../shared/test/helpers/deltaSequence";
import { SnapshotStore, STORE_STORED } from "../../src/net/snapshotStore";

// NET-02 (a) through the real client store (M3 design §5: "server encoder + client store"): the
// shared unit (`shared/test/net/delta.test.ts`) runs the same driver on a model of the store's
// rules, since shared cannot import the client; this runs `SnapshotStore` itself, on a shorter
// stretch of the same seeded sequence that still holds both kinds of forced miss.

const TICKS = 8000;

/** `SnapshotStore` as the driver sees it. */
class RealStore implements DeltaStore {
  readonly store = new SnapshotStore();
  private readonly reader = new BitReader();
  get ring() {
    return this.store.ring;
  }
  get newestTick(): number {
    return this.store.newestTick;
  }
  get ackTick(): number {
    return this.store.ackTick;
  }
  receive(bytes: Uint8Array): WorldFrame | null {
    this.reader.reset(bytes, bytes.length);
    return this.store.receive(this.reader, DELTA_SELF) === STORE_STORED
      ? this.store.lastStored
      : null;
  }
}

describe("NET-02: the client store keeps the server's frames over impaired links (M3 design §2.3)", () => {
  it(`${TICKS} ticks of the NET-02 (a) sequence through SnapshotStore`, () => {
    const real = new RealStore();
    const run = runDeltaSequence(real, TICKS);
    const s = real.store;
    const summary =
      `NET-02 (a), real store: ${run.matched} matched, ${s.delta} deltas / ${s.full} full, ` +
      `${s.baselineDrops} baseline drops, ${run.fullRequests} full requests, ${s.stale} stale`;
    expect(run.failures.slice(0, 5), summary).toEqual([]);
    expect(s.bad).toBe(0);
    expect(run.matched).toBe(s.stored);
    expect(s.stored).toBe(s.delta + s.full);
    expect(run.matched, summary).toBeGreaterThan(TICKS * 0.8);
    expect(s.delta, summary).toBeGreaterThan(s.full * 5);
    expect(run.forcedMisses).toBe(3);
    expect(s.baselineDrops, summary).toBeGreaterThan(0);
    expect(run.fullRequests, summary).toBeGreaterThan(0);
    expect(s.stale).toBeGreaterThan(0);
  });
});
