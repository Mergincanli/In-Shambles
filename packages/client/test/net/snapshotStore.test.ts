import {
  BitReader,
  BitWriter,
  encodeSnapshot,
  frameDigest,
  MAX_UNRELIABLE_BYTES,
  PlayerState,
  playerStateToSlot,
  SNAP_FLAG_SPECTATOR,
  SnapshotHeader,
  WorldFrame,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  SnapshotStore,
  STORE_BAD,
  STORE_SPECTATOR,
  STORE_STALE,
  STORE_STORED,
} from "../../src/net/snapshotStore";

const SELF = 2;

/** The bytes of a full snapshot of `tick` for receiver SELF, players 0–3 present. */
function snapshot(tick: number, flags = 0): Uint8Array {
  const h = new SnapshotHeader();
  h.serverTick = tick;
  h.flags = flags;
  h.inputBufferHealth = 2;
  const f = new WorldFrame();
  const ps = new PlayerState();
  for (let s = 0; s < 4; s++) {
    f.setPresent(s, tick);
    ps.origin[0] = tick + s;
    playerStateToSlot(f, s, ps);
  }
  f.teleportSeq[SELF] = 1;
  const w = new BitWriter(MAX_UNRELIABLE_BYTES);
  if (!encodeSnapshot(w, h, f, null, (flags & SNAP_FLAG_SPECTATOR) !== 0 ? -1 : SELF)) {
    throw new Error("test snapshot did not encode");
  }
  return w.bytes.slice(0, w.byteLength);
}

const reader = new BitReader();
function receive(store: SnapshotStore, bytes: Uint8Array): number {
  reader.reset(bytes, bytes.length);
  return store.receive(reader, SELF);
}

describe("SnapshotStore (M3 design §2.3)", () => {
  it("stores each snapshot as its tick's frame, as the receiver holds it", () => {
    const store = new SnapshotStore();
    expect([store.lastStored, store.newest, store.newestTick]).toEqual([null, null, 0]);
    expect(receive(store, snapshot(10))).toBe(STORE_STORED);
    const f = store.ring.get(10);
    expect(f).toBe(store.lastStored);
    expect(store.header.serverTick).toBe(10);
    expect(store.header.teleportSeq).toBe(1);
    expect(f?.presentCount).toBe(4);
    expect(f?.originX[3]).toBe(13 * 32);
    expect([store.newestTick, store.stored, store.full]).toEqual([10, 1, 1]);
  });

  it("swaps decode targets in, so a later snapshot never overwrites a stored frame", () => {
    const store = new SnapshotStore();
    receive(store, snapshot(10));
    const first = store.ring.get(10) as WorldFrame;
    const digest = frameDigest(first, SELF);
    for (let t = 11; t < 40; t++) receive(store, snapshot(t));
    expect(store.ring.get(10)).toBe(first);
    expect(frameDigest(first, SELF)).toBe(digest);
  });

  it("keeps a reordered older snapshot whose slot is free, and counts duplicates as stale", () => {
    const store = new SnapshotStore();
    receive(store, snapshot(20));
    expect(receive(store, snapshot(18))).toBe(STORE_STORED);
    expect(store.newestTick).toBe(20);
    expect(store.ring.has(18)).toBe(true);
    // `lastStored` is what was just stored (the older tick); `newest` stays the newest tick's.
    expect(store.lastStored).toBe(store.ring.get(18));
    expect(store.newest).toBe(store.ring.get(20));
    expect(receive(store, snapshot(20))).toBe(STORE_STALE);
    expect(receive(store, snapshot(18))).toBe(STORE_STALE);
    expect([store.stored, store.stale]).toEqual([2, 2]);
  });

  it("holds 64 ticks: tick + 64 evicts tick, and tick − 64 behind a newer one is stale", () => {
    const store = new SnapshotStore();
    receive(store, snapshot(100));
    expect(receive(store, snapshot(164))).toBe(STORE_STORED);
    expect([store.ring.has(100), store.ring.has(164)]).toEqual([false, true]);
    expect(receive(store, snapshot(100))).toBe(STORE_STALE);
  });

  it("refuses a spectator snapshot on a live connection, before reading its body", () => {
    const store = new SnapshotStore();
    expect(receive(store, snapshot(5, SNAP_FLAG_SPECTATOR))).toBe(STORE_SPECTATOR);
    expect([store.spectatorDropped, store.stored, store.lastStored]).toEqual([1, 0, null]);
  });

  it("leaves the store as it was when a snapshot does not decode", () => {
    const store = new SnapshotStore();
    receive(store, snapshot(7));
    const held = store.ring.get(7);
    const bad = snapshot(8);
    const truncated = bad.slice(0, bad.length - 3);
    expect(receive(store, truncated)).toBe(STORE_BAD);
    expect(receive(store, new Uint8Array([5, 0, 0]))).toBe(STORE_BAD);
    expect([store.bad, store.newestTick, store.ring.has(8)]).toEqual([2, 7, false]);
    expect(store.lastStored).toBe(held);
    // A body read as another receiver, whose own id is listed, is refused too.
    reader.reset(bad, bad.length);
    expect(store.receive(reader, 3)).toBe(STORE_BAD);
    store.reset();
    expect([store.lastStored, store.newestTick, store.ring.has(7)]).toEqual([null, 0, false]);
  });
});
