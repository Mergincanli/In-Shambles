import {
  BitWriter,
  copySlot,
  createLoopbackPair,
  ENTITY_DELTA_MAX_BITS,
  ENTITY_NEW_BITS,
  ENTITY_REMOVED_BITS,
  entityRecordBits,
  FRAME_SLOTS,
  localBlockBits,
  MATCH_MAX_CLIENTS,
  MAX_UNRELIABLE_BYTES,
  Mulberry32,
  SNAP_BUDGET_BITS,
  SNAP_DEFERRED_COUNT_BITS,
  SNAP_DEFERRED_ID_BITS,
  SNAP_DELTA_FIXED_BITS,
  SNAP_ENTITY_COUNT_BITS,
  SNAP_FIT_MAX_PLAYERS,
  SNAP_FULL_FIXED_BITS,
  SNAP_HEADER_BITS,
  SNAP_MAX_STALENESS,
  SNAP_MIN_CAPACITY,
  SNAP_MIN_CAPACITY_FULL,
  SnapshotHeader,
  WorldFrame,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { DELTA_SELF } from "../../../shared/test/helpers/deltaSequence";
import { WorldHistory } from "../../src/match/history";
import { Match } from "../../src/match/match";
import { MirrorPool, sentFrame } from "../../src/match/mirror";
import {
  buildSnapshot,
  SCHED_DEFERRED,
  SCHED_DROPPED,
  SCHED_FRESH,
  SCHED_REMOVED,
  SnapshotScheduler,
  worstCaseBits,
} from "../../src/match/scheduler";
import { loadMap, TEST_BUILD } from "./fixtures";
import { DriverClient, runScheduled, SlotWorld, worstCrowd } from "./scheduledSequence";

// The byte-budget scheduler (M3 design §2.3 and §5 "Scheduler", D-046): its bound, its worst-case
// check, its accounting, its order and rotation, commit on success, the mirror; then NET-02 (a)'s
// scheduled legs through the match's own snapshot build (`scheduledSequence.ts`).

const SELF = DELTA_SELF;

/** A world of `n` players (ids 0…n − 1, the receiver among them) captured at `t` into `history`. */
function crowd(history: WorldHistory, world: SlotWorld, n: number, t: number): WorldFrame {
  worstCrowd(n)(world, t);
  const f = history.frameFor(t);
  world.capture(f, t);
  history.stored(t);
  return f;
}

/** Sends the snapshot of `t` to `c` through `buildSnapshot`; the writer holds it. */
function send(
  sched: SnapshotScheduler,
  w: BitWriter,
  history: WorldHistory,
  c: DriverClient,
  t: number,
): boolean {
  const h = new SnapshotHeader();
  return buildSnapshot(sched, w, h, history, c, SELF, t, null);
}

/** Slot `s` of `cur` at its worst against a baseline at zero (a 233-bit delta record). */
function worstRow(cur: WorldFrame, s: number): void {
  cur.originX[s] = 524288;
  cur.originY[s] = -524288;
  cur.originZ[s] = 524288;
  cur.entVelX[s] = 32767;
  cur.entVelY[s] = -32767;
  cur.entVelZ[s] = 32767;
  cur.yaw[s] = 1;
  cur.pitch[s] = 1;
  cur.flags[s] = 1;
  cur.team[s] = 1;
  cur.teleportSeq[s] = 1;
  cur.eventSeq[s] = 1;
}

/**
 * Slots 0…`last` present (the receiver among them), the remotes at their worst at `t` against a
 * baseline of 90 that holds them all, each last sent fresh at `lastSent`; the client has seen all.
 */
function crafted(c: DriverClient, last: number, t: number, lastSent: number) {
  const base = new WorldFrame();
  const cur = new WorldFrame();
  for (let s = 0; s <= last; s++) {
    base.setPresent(s, 90);
    cur.setPresent(s, t);
    c.sentSerial[s] = 0;
    c.lastSent[s] = lastSent;
    if (s !== SELF) worstRow(cur, s);
  }
  return { base, cur };
}

describe("SnapshotScheduler (M3 design §2.3, D-046)", () => {
  it("rests on a static bound: 34 records fit any delta (37 full), so 2 snapshots carry all 63", () => {
    const left = (MATCH_MAX_CLIENTS - 1) * ENTITY_REMOVED_BITS;
    const fixed = SNAP_DELTA_FIXED_BITS + SNAP_DEFERRED_COUNT_BITS;
    expect(fixed).toBe(318);
    expect(SNAP_MIN_CAPACITY).toBe(
      Math.floor((SNAP_BUDGET_BITS - fixed - left) / (ENTITY_DELTA_MAX_BITS - 17)),
    );
    expect(SNAP_MIN_CAPACITY).toBe(34);
    expect(SNAP_MIN_CAPACITY_FULL).toBe(
      Math.floor(
        (SNAP_BUDGET_BITS - SNAP_FULL_FIXED_BITS - SNAP_DEFERRED_COUNT_BITS - left) /
          (ENTITY_NEW_BITS - 17),
      ),
    );
    expect(SNAP_MIN_CAPACITY_FULL).toBe(37);
    expect(2 * SNAP_MIN_CAPACITY).toBeGreaterThanOrEqual(MATCH_MAX_CLIENTS - 1);
    expect(SNAP_MAX_STALENESS).toBe(2);
    expect(SNAP_DEFERRED_ID_BITS).toBe(16);
  });

  it("bypasses the size pass while the worst case fits: ≤ 36 remotes and no removals", () => {
    const history = new WorldHistory();
    const world = new SlotWorld(new Mulberry32(1));
    const sched = new SnapshotScheduler();
    const c = new DriverClient();
    const w = new BitWriter(MAX_UNRELIABLE_BYTES);
    for (let t = 1; t <= 4; t++) {
      crowd(history, world, SNAP_FIT_MAX_PLAYERS, t);
      expect(send(sched, w, history, c, t)).toBe(true);
      expect([sched.sizePass, sched.deferred, sched.dropped]).toEqual([false, 0, 0]);
      // Every slot's last fresh tick advances in the bypass too.
      expect(c.lastSent[0]).toBe(t);
      if (t > 1) c.ackTick = t - 1;
    }
    // The worst case against an exact one: 36 remotes at their worst, 8700 bits, within budget.
    const cur = history.frameFor(4);
    const base = history.frameFor(3);
    expect(worstCaseBits(cur, base)).toBe(SNAP_DELTA_FIXED_BITS + 36 * ENTITY_DELTA_MAX_BITS);
    let exact = SNAP_HEADER_BITS + localBlockBits(cur, base, SELF) + SNAP_ENTITY_COUNT_BITS;
    for (let s = 0; s < FRAME_SLOTS; s++) if (s !== SELF) exact += entityRecordBits(cur, base, s);
    expect(exact).toBeLessThanOrEqual(worstCaseBits(cur, base));
    expect(worstCaseBits(cur, null)).toBe(SNAP_FULL_FIXED_BITS + 36 * ENTITY_NEW_BITS);
    // No frame was mirrored: all plain.
    expect(c.mirror).toBeNull();
  });

  it("fails the check at 36 remotes + 6 removals and keeps the snapshot within budget", () => {
    const history = new WorldHistory();
    const world = new SlotWorld(new Mulberry32(2));
    const sched = new SnapshotScheduler();
    const c = new DriverClient();
    c.mirror = new MirrorPool().acquire();
    const w = new BitWriter(MAX_UNRELIABLE_BYTES);
    crowd(history, world, 43, 1);
    expect(send(sched, w, history, c, 1)).toBe(true);
    c.ackTick = 1;
    for (let s = 37; s < 43; s++) world.leave(s);
    const cur = crowd(history, world, 37, 2);
    expect(worstCaseBits(cur, history.frameFor(1))).toBe(8700 + 6 * 17);
    expect(send(sched, w, history, c, 2)).toBe(true);
    expect(sched.sizePass).toBe(true);
    expect(w.bitLength).toBeLessThanOrEqual(SNAP_BUDGET_BITS);
    // The 6 removals all went; someone else waits a tick.
    for (let s = 37; s < 43; s++) expect(sched.decision[s]).toBe(SCHED_REMOVED);
    expect(sched.deferred).toBeGreaterThan(0);
  });

  it("fits 34 of 63 worst records and defers the other 29: 8704 bits (the accounting)", () => {
    const history = new WorldHistory();
    const world = new SlotWorld(new Mulberry32(3));
    const sched = new SnapshotScheduler();
    const c = new DriverClient();
    c.mirror = new MirrorPool().acquire();
    const w = new BitWriter(MAX_UNRELIABLE_BYTES);
    crowd(history, world, 64, 1);
    // A full first snapshot: at least SNAP_MIN_CAPACITY_FULL (37) new bodies fit; with 16-bit
    // out costs and no removals, 292 + 6 + 63 × 16 + 38 × 197 ≤ 8800 < … + 39 × 197: 38 go.
    expect(send(sched, w, history, c, 1)).toBe(true);
    expect([sched.deferred, 63 - sched.deferred]).toEqual([25, 38]);
    c.ackTick = 1;
    // Make every slot fresh at 1 in the baseline's eyes, so nobody is due: tick 2 has 63 worst
    // records against a baseline that holds all 63 (a mirror copy of tick 1 with every row fresh).
    const mirror1 = c.mirror.ring.slot(1);
    for (let s = 0; s < FRAME_SLOTS; s++) copySlot(mirror1, s, history.frameFor(1), s);
    c.mirror.ring.store(1);
    c.lastSent.fill(1);
    c.lastDeferred.fill(0);
    crowd(history, world, 64, 2);
    expect(send(sched, w, history, c, 2)).toBe(true);
    // The local block is at its worst too only by chance; the records are: 34 × 233 + 29 × 16.
    const local = localBlockBits(history.frameFor(2), mirror1, SELF);
    expect(w.bitLength).toBe(SNAP_HEADER_BITS + local + 7 + 6 + 34 * 233 + 29 * 16);
    expect([sched.deferred, sched.dropped]).toEqual([29, 0]);
    // Ties in staleness and last deferral go by id: the first 34 others go, the last 29 wait.
    const fresh: number[] = [];
    for (let s = 0; s < FRAME_SLOTS; s++) if (sched.decision[s] === SCHED_FRESH) fresh.push(s);
    expect(fresh.length).toBe(34);
    expect(Math.max(...fresh)).toBe(34);
    // Next tick those 29 are due (staleness 2): all of them go, and 5 more.
    c.ackTick = 2;
    crowd(history, world, 64, 3);
    expect(send(sched, w, history, c, 3)).toBe(true);
    for (let s = 35; s < 64; s++) expect(sched.decision[s], `slot ${s}`).toBe(SCHED_FRESH);
    expect(sched.overrun).toBe(false);
    expect(sched.maxStaleness).toBe(2);
    expect(w.byteLength).toBeLessThanOrEqual(1100);
  });

  it("rotates under sustained pressure: no id keeps a fixed rate", () => {
    const history = new WorldHistory();
    const world = new SlotWorld(new Mulberry32(4));
    const sched = new SnapshotScheduler();
    const c = new DriverClient();
    c.mirror = new MirrorPool().acquire();
    const w = new BitWriter(MAX_UNRELIABLE_BYTES);
    const freshCount = new Int32Array(FRAME_SLOTS);
    const ticks = 600;
    for (let t = 1; t <= ticks; t++) {
      crowd(history, world, 64, t);
      if (t > 1) c.ackTick = t - 1;
      expect(send(sched, w, history, c, t)).toBe(true);
      expect(sched.maxStaleness).toBeLessThanOrEqual(2);
      for (let s = 0; s < FRAME_SLOTS; s++) if (sched.decision[s] === SCHED_FRESH) freshCount[s]++;
    }
    const shares: number[] = [];
    for (let s = 0; s < FRAME_SLOTS; s++) if (s !== SELF) shares.push(freshCount[s] / ticks);
    // Everyone at the same rate, low and high ids alike (records shrink once a slot's copy is two
    // ticks old, so more than 34 fit: about 2 ticks in 3).
    expect(Math.min(...shares)).toBeGreaterThan(0.5);
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThan(0.02);
  });

  it("always includes the due ones first, then fits what it can (first fit skips and goes on)", () => {
    const sched = new SnapshotScheduler();
    const c = new DriverClient();
    const base = new WorldFrame();
    const cur = new WorldFrame();
    const t = 100;
    // 50 remotes at their worst (233 bits each) and the receiver: 4 are due (left out at 99).
    for (let s = 0; s <= 50; s++) {
      base.setPresent(s, 90);
      cur.setPresent(s, t);
      c.sentSerial[s] = 0;
      c.lastSent[s] = 99;
      if (s === SELF) continue;
      cur.originX[s] = 524288;
      cur.originY[s] = -524288;
      cur.originZ[s] = 524288;
      cur.entVelX[s] = 32767;
      cur.entVelY[s] = -32767;
      cur.entVelZ[s] = 32767;
      cur.yaw[s] = 1;
      cur.pitch[s] = 1;
      cur.flags[s] = 1;
      cur.team[s] = 1;
      cur.teleportSeq[s] = 1;
      cur.eventSeq[s] = 1;
    }
    for (const s of [40, 45, 47, 50]) c.lastSent[s] = 98;
    // Slot 49 changed only its yaw: a small record (42 bits) that fits after the big ones stop.
    cur.originX[49] = 0;
    cur.originY[49] = 0;
    cur.originZ[49] = 0;
    cur.entVelX[49] = 0;
    cur.entVelY[49] = 0;
    cur.entVelZ[49] = 0;
    cur.pitch[49] = 0;
    cur.flags[49] = 0;
    cur.team[49] = 0;
    cur.teleportSeq[49] = 0;
    cur.eventSeq[49] = 0;
    expect(entityRecordBits(cur, base, 49)).toBe(42);
    expect(sched.schedule(cur, base, SELF, t, c)).toBe(false);
    for (const s of [40, 45, 47, 50]) expect(sched.decision[s], `due ${s}`).toBe(SCHED_FRESH);
    expect(sched.decision[49]).toBe(SCHED_FRESH);
    expect(sched.decision[48]).toBe(SCHED_DEFERRED);
    expect(sched.overrun).toBe(false);
    expect(sched.bits).toBeLessThanOrEqual(SNAP_BUDGET_BITS);
    // The next rows: a left-out player keeps its last fresh tick and records the deferral.
    expect([sched.nextLastSent[48], sched.nextLastDeferred[48]]).toEqual([99, t]);
    expect([sched.nextLastSent[49], sched.nextLastDeferred[49]]).toEqual([t, 0]);
  });

  it("counts a mandatory record it cannot fit as sched_overrun (impossible by the bound)", () => {
    const sched = new SnapshotScheduler();
    const c = new DriverClient();
    const t = 100;
    // 50 remotes all due (left out at 99, carried fresh at 98): more than SNAP_MIN_CAPACITY.
    const { base, cur } = crafted(c, 50, t, 98);
    c.lastDeferred.fill(99);
    expect(sched.schedule(cur, base, SELF, t, c)).toBe(false);
    expect(sched.overrun).toBe(true);
    expect(sched.bits).toBeLessThanOrEqual(SNAP_BUDGET_BITS);
    // Equal priority: by id, the first ones go while they fit.
    const fresh: number[] = [];
    const ids: number[] = [];
    for (let s = 0; s <= 50; s++) {
      if (s === SELF) continue;
      ids.push(s);
      if (sched.decision[s] === SCHED_FRESH) fresh.push(s);
    }
    expect(fresh.length).toBeGreaterThanOrEqual(SNAP_MIN_CAPACITY);
    expect(fresh).toEqual(ids.slice(0, fresh.length));
    // The same crowd one tick fresher overruns nothing.
    const fine = crafted(new DriverClient(), 50, t, 99);
    expect(sched.schedule(fine.cur, fine.base, SELF, t, new DriverClient())).toBe(false);
    expect(sched.overrun).toBe(false);
  });

  it("counts a new player it leaves out as seen at T − 1, so it is due next tick", () => {
    const sched = new SnapshotScheduler();
    const c = new DriverClient();
    const t = 100;
    const { base, cur } = crafted(c, 50, t, 99);
    // Slot 50 is a player this client has never been sent (absent in the baseline).
    base.setAbsent(50);
    c.sentSerial[50] = -1;
    c.lastSent[50] = 0;
    expect(sched.schedule(cur, base, SELF, t, c)).toBe(false);
    expect(sched.decision[50]).toBe(SCHED_DEFERRED);
    expect([sched.nextLastSent[50], sched.nextLastDeferred[50]]).toEqual([t - 1, t]);
  });

  it("does not blink out a reused slot's new player the client was already sent", () => {
    const sched = new SnapshotScheduler();
    const c = new DriverClient();
    const t = 100;
    const { base, cur } = crafted(c, 50, t, 99);
    // Slot 50 changed hands: the baseline (acked) still holds the old player (serial 0), but the
    // client was sent the new one (serial 1) fresh at 99. Without its rank it would be the last
    // in the order (highest id, never left out) and go out as a removal.
    cur.serial[50] = 1;
    c.sentSerial[50] = 1;
    expect(sched.schedule(cur, base, SELF, t, c)).toBe(false);
    expect(sched.decision[50]).toBe(SCHED_FRESH);
    expect(sched.dropped).toBe(0);
    // One the client has not been sent yet is still dropped as a removal when it does not fit.
    c.sentSerial[50] = 0;
    expect(sched.schedule(cur, base, SELF, t, c)).toBe(false);
    expect(sched.decision[50]).toBe(SCHED_DROPPED);
  });

  it("sends a reused slot it leaves out as removed, then as a due new player next tick", () => {
    const history = new WorldHistory();
    const world = new SlotWorld(new Mulberry32(5));
    const sched = new SnapshotScheduler();
    const c = new DriverClient();
    c.mirror = new MirrorPool().acquire();
    const w = new BitWriter(MAX_UNRELIABLE_BYTES);
    for (let t = 1; t <= 3; t++) {
      crowd(history, world, 64, t);
      if (t > 1) c.ackTick = t - 1;
      expect(send(sched, w, history, c, t)).toBe(true);
    }
    // Every slot left out at 3 is due at 4; reuse a slot that went at 3 (not due) and is the last
    // in the order: the oldest last deferral, the highest id among those.
    let reused = -1;
    for (let s = FRAME_SLOTS - 1; s >= 0; s--) {
      if (s === SELF || sched.decision[s] !== SCHED_FRESH) continue;
      if (reused < 0 || (c.lastDeferred[s] as number) < (c.lastDeferred[reused] as number)) {
        reused = s;
      }
    }
    expect(reused).toBeGreaterThan(0);
    world.leave(reused);
    world.join(reused, 4);
    c.ackTick = 3;
    crowd(history, world, 64, 4);
    expect(send(sched, w, history, c, 4)).toBe(true);
    expect(sched.decision[reused]).toBe(SCHED_DROPPED);
    const sent4 = sentFrame(history, c.mirror, 4) as WorldFrame;
    expect(sent4.present[reused]).toBe(0);
    // Committed as seen at 3: due (staleness 2) at 5 whatever the rotation says.
    expect([c.lastSent[reused], c.lastDeferred[reused]]).toEqual([3, 4]);
    c.ackTick = 4;
    crowd(history, world, 64, 5);
    expect(send(sched, w, history, c, 5)).toBe(true);
    expect(sched.decision[reused]).toBe(SCHED_FRESH);
    const sent5 = sentFrame(history, c.mirror, 5) as WorldFrame;
    expect([sent5.present[reused], sent5.stamp[reused]]).toEqual([1, 5]);
    expect(sched.maxStaleness).toBe(2);
  });

  it("a failed encode sends nothing and changes nothing but the sent ring (snapshot_overflow)", () => {
    const history = new WorldHistory();
    const world = new SlotWorld(new Mulberry32(6));
    const sched = new SnapshotScheduler();
    const c = new DriverClient();
    c.mirror = new MirrorPool().acquire();
    const w = new BitWriter(MAX_UNRELIABLE_BYTES);
    for (let t = 1; t <= 3; t++) {
      crowd(history, world, 64, t);
      if (t > 1) c.ackTick = t - 1;
      expect(send(sched, w, history, c, t)).toBe(true);
    }
    const before = [c.lastSent.slice(), c.lastDeferred.slice(), c.sentSerial.slice()];
    const newest = c.newestSent;
    c.ackTick = 3;
    crowd(history, world, 64, 4);
    // A writer too small for any snapshot: the encode fails.
    expect(send(sched, new BitWriter(64), history, c, 4)).toBe(false);
    expect([c.lastSent, c.lastDeferred, c.sentSerial]).toEqual(before);
    expect([c.sentTicks[4], c.newestSent]).toEqual([0, newest]);
    expect(c.mirror.ring.has(4)).toBe(false);
    // The next snapshot still codes against 3 and keeps every rule.
    crowd(history, world, 64, 5);
    expect(send(sched, w, history, c, 5)).toBe(true);
    expect(sched.maxStaleness).toBeLessThanOrEqual(3);
    expect(w.byteLength).toBeLessThanOrEqual(1100);
  });
});

describe("Match mirrors (M3 design §2.3, D-046)", () => {
  const cmap = loadMap("movement_lab");
  const connect = (m: Match) => m.connect(createLoopbackPair()[1]);

  it("allocates none at 32 players, one per session above 37, reused across reconnects", () => {
    const small = new Match({ cmap, buildHash: TEST_BUILD });
    for (let i = 0; i < 32; i++) connect(small);
    expect(small.mirrors.allocated).toBe(0);
    expect(small.session(0)?.mirror).toBeNull();
    const big = new Match({ cmap, buildHash: TEST_BUILD, maxClients: 64 });
    const [clientEnd, serverEnd] = createLoopbackPair();
    const first = big.connect(serverEnd);
    connect(big);
    expect(big.mirrors.allocated).toBe(2);
    expect(first?.mirror).not.toBeNull();
    clientEnd.close("bye");
    big.tick();
    expect(big.mirrors.spare).toBe(1);
    const again = connect(big);
    expect(again?.mirror).not.toBeNull();
    expect([big.mirrors.allocated, big.mirrors.spare]).toEqual([2, 0]);
  });

  it("gives every present session a mirror when the cap is raised above 37", () => {
    const m = new Match({ cmap, buildHash: TEST_BUILD });
    for (let i = 0; i < 3; i++) connect(m);
    expect(m.setMaxClients(37)).toBe(37);
    expect(m.mirrors.allocated).toBe(0);
    expect(m.setMaxClients(40)).toBe(40);
    expect(m.mirrors.allocated).toBe(3);
    for (let id = 0; id < 3; id++) expect(m.session(id)?.mirror).not.toBeNull();
    // Lowering it again keeps them, and a newcomer still gets one.
    m.setMaxClients(8);
    connect(m);
    expect(m.session(3)?.mirror).not.toBeNull();
  });
});

describe("NET-02: scheduled snapshots stay within 1100 B and match the server's frames (D-046)", () => {
  const expectClean = (run: ReturnType<typeof runScheduled>, label: string) => {
    const summary =
      `${label}: ${run.snapshots} snapshots, ${run.deferredSnapshots} deferring ` +
      `(${((100 * run.deferredSnapshots) / run.snapshots).toFixed(1)}%), ${run.deferredIds} ` +
      `deferred ids, ${run.dropped} reused slots dropped, ${run.sizePasses} size passes, max ` +
      `${run.maxBytes} B, max staleness ${run.maxStaleness}, ${run.matched} frames matched, ` +
      `${run.mirroredBaselines} mirrored baselines (oldest ${run.maxBaseBack} back)`;
    expect(run.failures, summary).toEqual([]);
    expect([run.overflow, run.overrun]).toEqual([0, 0]);
    expect(run.maxBytes).toBeLessThanOrEqual(1100);
    expect(run.maxStaleness).toBeLessThanOrEqual(SNAP_MAX_STALENESS);
    expect(run.store.bad).toBe(0);
    return summary;
  };

  it("64 slots at their worst every tick, with joins, leaves and reuse, over lossy links", () => {
    const step = (world: SlotWorld, t: number) => {
      const rng = world.rng;
      const f = world.live;
      for (let s = 0; s < FRAME_SLOTS; s++) {
        if (f.present[s] !== 1) {
          if (s === SELF || rng.nextInt(20) === 0) world.join(s, t);
          continue;
        }
        if (s === SELF) {
          world.moveSelf(s);
          continue;
        }
        const r = rng.nextInt(400);
        if (r === 0) world.leave(s);
        else if (r === 1) world.join(s, t);
        else world.worst(s);
      }
    };
    const run = runScheduled({ ticks: 3000, seed: 0x64, step, impaired: true });
    const summary = expectClean(run, "64 slots");
    expect(run.deferredSnapshots / run.snapshots, summary).toBeGreaterThan(0.9);
    expect(run.dropped, summary).toBeGreaterThan(0);
    expect(run.matched, summary).toBeGreaterThan(2000);
    expect(run.mirroredBaselines).toBeGreaterThan(1000);
    expect(run.pool.allocated).toBe(1);
  });

  it("deferral chains resolve against baselines up to 63 ticks old (slow acks)", () => {
    const run = runScheduled({
      ticks: 600,
      seed: 0x63,
      step: worstCrowd(64),
      impaired: false,
      delay: [28, 31],
    });
    const summary = expectClean(run, "slow acks");
    expect(run.maxBaseBack, summary).toBeGreaterThanOrEqual(56);
    expect(run.matched, summary).toBeGreaterThan(500);
  });

  it("43 → 37 players: 6 removals against an old baseline run the scheduler", () => {
    const step = (world: SlotWorld, t: number) => {
      const n = Math.floor(t / 60) % 2 === 0 ? 43 : 37;
      for (let s = n; s < 43; s++) if (world.live.present[s] === 1) world.leave(s);
      worstCrowd(n)(world, t);
    };
    const run = runScheduled({ ticks: 1200, seed: 0x43, step, impaired: true });
    const summary = expectClean(run, "43 → 37");
    expect(run.sizePasses, summary).toBeGreaterThan(run.snapshots / 2);
  });

  it("37 ↔ 38 players crossed again and again under worst motion", () => {
    const step = (world: SlotWorld, t: number) => {
      const n = Math.floor(t / 7) % 2 === 0 ? 37 : 38;
      if (n === 37 && world.live.present[37] === 1) world.leave(37);
      worstCrowd(n)(world, t);
    };
    const run = runScheduled({ ticks: 1200, seed: 0x38, step, impaired: true });
    const summary = expectClean(run, "37 ↔ 38");
    expect(run.deferredSnapshots, summary).toBeGreaterThan(100);
    expect(run.sizePasses, summary).toBeGreaterThan(run.deferredSnapshots);
  });
});
