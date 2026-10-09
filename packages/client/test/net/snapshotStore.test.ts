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
  BASELINE_MISSES_BEFORE_FULL,
  SnapshotStore,
  STORE_BAD,
  STORE_NO_BASELINE,
  STORE_SPECTATOR,
  STORE_STALE,
  STORE_STORED,
} from "../../src/net/snapshotStore";

const SELF = 2;

/** The server's frame of `tick`: players 0–3 present, each moving along x (player 3 left at 50). */
function serverFrame(tick: number): WorldFrame {
  const f = new WorldFrame();
  const ps = new PlayerState();
  for (let s = 0; s < 4; s++) {
    if (s === 3 && tick >= 50) continue;
    f.setPresent(s, tick);
    ps.origin[0] = tick + s;
    playerStateToSlot(f, s, ps);
  }
  f.teleportSeq[SELF] = 1;
  return f;
}

/**
 * The bytes of the snapshot of `tick` for receiver SELF: full, or a delta against the server's
 * frame of `baseTick`.
 */
function snapshot(tick: number, flags = 0, baseTick = 0): Uint8Array {
  const h = new SnapshotHeader();
  h.serverTick = tick;
  h.flags = flags;
  h.inputBufferHealth = 2;
  h.baseBack = baseTick === 0 ? 0 : tick - baseTick;
  const base = baseTick === 0 ? null : serverFrame(baseTick);
  const w = new BitWriter(MAX_UNRELIABLE_BYTES);
  const self = (flags & SNAP_FLAG_SPECTATOR) !== 0 ? -1 : SELF;
  if (!encodeSnapshot(w, h, serverFrame(tick), base, self)) {
    throw new Error("test snapshot did not encode");
  }
  return w.bytes.slice(0, w.byteLength);
}

function delta(tick: number, baseTick: number): Uint8Array {
  return snapshot(tick, 0, baseTick);
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
    expect([store.newestTick, store.stored, store.full, store.delta]).toEqual([10, 1, 1, 0]);
  });

  it("decodes a delta against its stored baseline into the frame the server encoded (D-038)", () => {
    const store = new SnapshotStore();
    receive(store, snapshot(40));
    expect(store.ackTick).toBe(40);
    for (let t = 41; t < 60; t++) {
      expect(receive(store, delta(t, store.ackTick)), `tick ${t}`).toBe(STORE_STORED);
      expect(store.header.baseBack).toBe(1);
      expect(frameDigest(store.ring.get(t) as WorldFrame, SELF)).toBe(
        frameDigest(serverFrame(t), SELF),
      );
      expect(store.ackTick).toBe(t);
    }
    // Player 3 left at 50: removed in that delta, absent since.
    expect([store.ring.get(49)?.present[3], store.ring.get(50)?.present[3]]).toEqual([1, 0]);
    // A delta against an older stored frame, and one that arrives late, behind the newest.
    expect(receive(store, delta(62, 45))).toBe(STORE_STORED);
    expect(receive(store, delta(61, 59))).toBe(STORE_STORED);
    expect(store.newestTick).toBe(62);
    expect([store.stored, store.full, store.delta, store.baselineDrops]).toEqual([22, 1, 21, 0]);
  });

  it("drops a delta whose baseline it does not hold, without striking it", () => {
    const store = new SnapshotStore();
    receive(store, snapshot(100));
    // Never stored, and evicted: tick 100 + 64 overwrote 100's slot.
    expect(receive(store, delta(105, 103))).toBe(STORE_NO_BASELINE);
    expect(receive(store, snapshot(164))).toBe(STORE_STORED);
    expect(receive(store, delta(163, 100))).toBe(STORE_NO_BASELINE);
    expect(receive(store, delta(166, 164))).toBe(STORE_STORED);
    expect([store.baselineDrops, store.bad, store.stored, store.ackTick]).toEqual([2, 0, 3, 166]);
    // A stale delta is dropped as stale before its baseline is looked up.
    expect(receive(store, delta(166, 120))).toBe(STORE_STALE);
    expect(store.baselineDrops).toBe(2);
  });

  it("acks 0 after 8 missing baselines in a row, until a full snapshot arrives", () => {
    const store = new SnapshotStore();
    receive(store, snapshot(10));
    expect(BASELINE_MISSES_BEFORE_FULL).toBe(8);
    // Lost baselines: deltas against ticks the client never got.
    for (let i = 0; i < BASELINE_MISSES_BEFORE_FULL - 1; i++) {
      expect(receive(store, delta(20 + i, 15))).toBe(STORE_NO_BASELINE);
    }
    expect(store.ackTick).toBe(10);
    // A stored snapshot breaks the run.
    expect(receive(store, delta(30, 10))).toBe(STORE_STORED);
    for (let i = 0; i < BASELINE_MISSES_BEFORE_FULL - 1; i++) receive(store, delta(31 + i, 25));
    expect(store.ackTick).toBe(30);
    receive(store, delta(40, 25));
    expect([store.ackTick, store.newestTick, store.baselineDrops]).toEqual([0, 30, 15]);
    // A delta that still decodes (the server had not seen the 0 yet) keeps asking.
    expect(receive(store, delta(41, 30))).toBe(STORE_STORED);
    expect(store.ackTick).toBe(0);
    expect(receive(store, snapshot(42))).toBe(STORE_STORED);
    expect(store.ackTick).toBe(42);
    receive(store, delta(43, 15));
    store.reset();
    expect([store.ackTick, store.newestTick]).toEqual([0, 0]);
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
