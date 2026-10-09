import { describe, expect, it } from "vitest";
import { BitReader, BitWriter } from "../../src/net/bitstream";
import { MAX_UNRELIABLE_BYTES } from "../../src/net/protocol";
import {
  decodeSnapshotBody,
  decodeSnapshotHeader,
  encodeSnapshot,
  SnapshotHeader,
} from "../../src/net/snapshot";
import { FrameRing, frameDigest, WorldFrame } from "../../src/net/worldFrame";
import { Mulberry32 } from "../../src/rng/mulberry32";
import {
  DELTA_SELF,
  type DeltaStore,
  runDeltaSequence,
  ServerSide,
  World,
} from "../helpers/deltaSequence";

// NET-02 (a), the unit (docs/05 §4.3, §14; M3 design §2.3 and §5, D-038), with the driver in
// `helpers/deltaSequence.ts`. Shared cannot import the client, so the store here is a model of
// `client/src/net/snapshotStore.ts`'s rules; `client/test/net/net-02-store.test.ts` runs the real
// store through the same driver, and `snapshotStore.test.ts` pins its rules one by one.

const TICKS = 20_000;
const MISSES_BEFORE_FULL = 8;

/** The client's store rules (`SnapshotStore`): baseline lookup, drops, the 8-drop full request. */
class StoreModel implements DeltaStore {
  readonly ring = new FrameRing();
  readonly header = new SnapshotHeader();
  private spare = new WorldFrame();
  private readonly reader = new BitReader();
  newestTick = 0;
  missRun = 0;
  wantFull = false;
  full = 0;
  delta = 0;
  stale = 0;
  drops = 0;
  bad = 0;

  get ackTick(): number {
    return this.wantFull ? 0 : this.newestTick;
  }

  receive(bytes: Uint8Array): WorldFrame | null {
    const r = this.reader;
    r.reset(bytes, bytes.length);
    const h = this.header;
    if (!decodeSnapshotHeader(r, h)) {
      this.bad++;
      return null;
    }
    const t = h.serverTick;
    if (this.ring.tickAt(t) >= t) {
      this.stale++;
      return null;
    }
    let base: WorldFrame | null = null;
    if (h.baseBack !== 0) {
      base = this.ring.get(t - h.baseBack);
      if (base === null) {
        this.drops++;
        if (++this.missRun >= MISSES_BEFORE_FULL) this.wantFull = true;
        return null;
      }
    }
    const f = this.spare;
    if (!decodeSnapshotBody(r, h, base, DELTA_SELF, f)) {
      this.bad++;
      return null;
    }
    this.spare = this.ring.swapIn(t, f);
    if (t > this.newestTick) this.newestTick = t;
    this.missRun = 0;
    if (base === null) {
      this.full++;
      this.wantFull = false;
    } else {
      this.delta++;
    }
    return f;
  }
}

describe("NET-02: delta snapshots match the server's frames (docs/05 §4.3, §14; M3 design §2.3)", () => {
  it(`${TICKS} ticks of joins, leaves, reuse, teleports and bursts over lossy links and hostile acks`, () => {
    const store = new StoreModel();
    const run = runDeltaSequence(store, TICKS);
    const meanDelta = run.deltaBytes / run.deltas;
    const meanFull = run.fullEquivalentBytes / run.deltas;
    // What the run did, in the first assertion's message (shared tests have no console).
    const summary =
      `NET-02 (a): ${run.matched} frames matched, ${store.delta} deltas / ${store.full} full ` +
      `stored (${((100 * store.delta) / (store.delta + store.full)).toFixed(1)}% delta), mean ` +
      `delta ${meanDelta.toFixed(0)} B vs ${meanFull.toFixed(0)} B full, ${store.drops} baseline ` +
      `drops, ${run.fullRequests} full requests, ${store.stale} stale, ${run.hostile} hostile acks`;
    expect(run.failures.slice(0, 5), summary).toEqual([]);
    expect(store.bad).toBe(0);
    expect(run.matched).toBe(store.delta + store.full);
    expect(run.matched, summary).toBeGreaterThan(TICKS * 0.8);
    expect(store.delta, summary).toBeGreaterThan(store.full * 5);
    expect(meanDelta, summary).toBeLessThanOrEqual(meanFull);
    // Per entity a delta record is at most a new one + 20 bits; the local block likewise.
    expect(run.worstEntityOver).toBeLessThanOrEqual(20);
    expect(run.worstLocalOver).toBeLessThanOrEqual(20);
    // The impairments did their job: drops, the 8-drop full request, stale and duplicate copies,
    // fulls when the acks aged out of the window.
    expect(run.forcedMisses).toBeGreaterThan(0);
    expect(store.drops).toBeGreaterThan(0);
    expect(run.fullRequests, summary).toBeGreaterThan(0);
    expect(store.stale).toBeGreaterThan(0);
    expect(run.fullsAfterValidAck).toBeGreaterThan(0);
  });

  it("a server-side miss (a tick never sent) is never a baseline, and ack 0 asks for a full one", () => {
    // Checks of the server model (`ServerSide`) until the match's own rule lands (increment 9).
    const server = new ServerSide();
    const store = new StoreModel();
    const world = new World(new Mulberry32(7));
    const w = new BitWriter(MAX_UNRELIABLE_BYTES);
    const hdr = new SnapshotHeader();
    const send = (t: number): number => {
      world.step(t, false);
      const cur = server.history.slot(t);
      world.capture(cur, t);
      server.history.store(t);
      const b = server.baseline(t);
      hdr.serverTick = t;
      hdr.baseBack = b === 0 ? 0 : t - b;
      w.reset();
      expect(encodeSnapshot(w, hdr, cur, b === 0 ? null : server.history.get(b), DELTA_SELF)).toBe(
        true,
      );
      server.sent(t);
      const f = store.receive(w.bytes.slice(0, w.byteLength));
      expect(f).not.toBeNull();
      expect(frameDigest(f as WorldFrame, DELTA_SELF)).toBe(frameDigest(cur, DELTA_SELF));
      return hdr.baseBack;
    };
    expect(send(1)).toBe(0);
    server.onAck(store.ackTick, 2);
    expect(send(2)).toBe(1);
    // Tick 2 turns out never sent (a server-side encode failure): an ack of it is ignored.
    server.unsend(2);
    server.onAck(2, 3);
    expect(server.baseline(3)).toBe(1);
    server.onAck(0, 3);
    expect(send(3)).toBe(0);
    server.onAck(3, 4);
    expect(send(4)).toBe(1);
    // Exactly 63 back is still a baseline; 64 back is past the window: full.
    for (let t = 5; t < 66; t++) send(t);
    expect(server.baseline(66)).toBe(3);
    expect(server.baseline(67)).toBe(0);
  });
});
