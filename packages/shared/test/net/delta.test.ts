import { describe, expect, it } from "vitest";
import { BitWriter } from "../../src/net/bitstream";
import { MAX_UNRELIABLE_BYTES } from "../../src/net/protocol";
import { encodeSnapshot, SnapshotHeader } from "../../src/net/snapshot";
import { frameDigest, type WorldFrame } from "../../src/net/worldFrame";
import { Mulberry32 } from "../../src/rng/mulberry32";
import {
  DELTA_SELF,
  runDeltaSequence,
  ServerSide,
  StoreModel,
  World,
} from "../helpers/deltaSequence";

// NET-02 (a), the unit (docs/05 §4.3, §14; M3 design §2.3 and §5, D-038), with the driver in
// `helpers/deltaSequence.ts`. Shared cannot import the client, so the store here is a model of
// `client/src/net/snapshotStore.ts`'s rules (`StoreModel`); `client/test/net/net-02-store.test.ts`
// runs the real store through the same driver, and `snapshotStore.test.ts` pins its rules one by
// one.

const TICKS = 20_000;
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
    // Checks of the server model (`ServerSide`); `server/test/match/match.test.ts` runs the same
    // rules on the match's own code (its NET-02 describe).
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
