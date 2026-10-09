import { BitWriter } from "../../src/net/bitstream";
import { MAX_UNRELIABLE_BYTES, SNAPSHOT_HISTORY } from "../../src/net/protocol";
import {
  ENTITY_NEW_BITS,
  encodeSnapshot,
  entityRecordBits,
  localBlockBits,
  SNAP_FIT_MAX_PLAYERS,
  SNAP_FULL_FIXED_BITS,
  SnapshotHeader,
} from "../../src/net/snapshot";
import {
  copySlot,
  FRAME_SLOTS,
  FrameRing,
  frameDigest,
  pushEntityEvent,
  WorldFrame,
} from "../../src/net/worldFrame";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { PMEV_JUMP, PMEV_LAND, PMEV_STEP } from "../../src/sim/events";
import { intIn, mutateEntity, mutateLocal, randomEntity } from "./netMessages";

// NET-02 (a)'s driver (docs/05 §4.3, §14; M3 design §2.3 and §5, D-038): a long, seeded world
// sequence goes through the snapshot encoder with the server's baseline rule and into a client
// store, over impaired links both ways, and every stored frame must be the frame the server
// encoded. The store is a parameter: `shared/test/net/delta.test.ts` runs a model of the client's
// rules (shared cannot import the client), `client/test/net/net-02-store.test.ts` runs the real
// `SnapshotStore` through the same driver. The server's rule (`ServerSide`: ack = the newest valid
// acked tick; ahead, stale or unsent acks ignored; 0 asks for a full snapshot) is the design's and
// is a model until the match's own lands in increment 9. The players stay below
// SNAP_FIT_MAX_PLAYERS by id, so every snapshot fits 1100 B without the D-046 scheduler.

/** The receiver's id. */
export const DELTA_SELF = 5;
/** Ids below this (D-034: 37 by construction until the scheduler). */
const SLOTS = SNAP_FIT_MAX_PLAYERS;
const RING = SNAPSHOT_HISTORY - 1;

/** The world: per-slot serials and the live frame the server simulates (D-034, D-035). */
export class World {
  readonly live = new WorldFrame();
  private readonly serials = new Uint16Array(FRAME_SLOTS);
  /** Slots to rejoin next tick (a reuse right after a leave). */
  private readonly rejoin = new Uint8Array(FRAME_SLOTS);
  constructor(private readonly rng: Mulberry32) {
    this.join(DELTA_SELF, 0);
  }

  private join(s: number, t: number): void {
    const f = this.live;
    const teleportSeq = f.teleportSeq[s] as number;
    const eventSeq = f.eventSeq[s] as number;
    randomEntity(this.rng, f, s, t);
    mutateLocal(this.rng, f, s);
    this.serials[s] = ((this.serials[s] as number) + 1) & 0xffff;
    f.serial[s] = this.serials[s] as number;
    // Every spawn bumps the slot's counter, which persists across incarnations (D-035).
    f.teleportSeq[s] = (teleportSeq + 1) & 0xff;
    f.eventSeq[s] = eventSeq;
  }

  /** One tick of joins, leaves, moves, teleports and event bursts; `idle` changes nothing. */
  step(t: number, idle: boolean): void {
    const rng = this.rng;
    const f = this.live;
    if (idle) return;
    for (let s = 0; s < SLOTS; s++) {
      if (f.present[s] !== 1) {
        if (this.rejoin[s] === 1 || rng.nextInt(400) === 0) {
          this.rejoin[s] = 0;
          this.join(s, t);
        }
        continue;
      }
      if (s !== DELTA_SELF && rng.nextInt(600) === 0) {
        f.setAbsent(s);
        if (rng.nextInt(3) === 0) this.rejoin[s] = 1;
        continue;
      }
      const r = rng.nextInt(100);
      if (s === DELTA_SELF) {
        if (r < 60) mutateLocal(rng, f, s);
        if (r === 99) f.teleportSeq[s] = ((f.teleportSeq[s] as number) + 1) & 0xff;
        continue;
      }
      if (r < 50) {
        // Walking: small steps of origin and velocity.
        f.originX[s] = Math.max(
          -524288,
          Math.min(524288, (f.originX[s] as number) + intIn(rng, -400, 400)),
        );
        f.originY[s] = Math.max(
          -524288,
          Math.min(524288, (f.originY[s] as number) + intIn(rng, -40, 40)),
        );
        f.entVelX[s] = Math.max(
          -32767,
          Math.min(32767, (f.entVelX[s] as number) + intIn(rng, -20, 20)),
        );
      } else if (r < 56) {
        mutateEntity(rng, f, s);
      } else if (r < 58) {
        // A teleport (a respawn in place of the slot's player): far away, counter bumped.
        f.originX[s] = intIn(rng, -524288, 524288);
        f.originZ[s] = intIn(rng, -524288, 524288);
        f.teleportSeq[s] = ((f.teleportSeq[s] as number) + 1) & 0xff;
      } else if (r < 60) {
        // An event burst: one to four events in the tick, the newest two kept.
        const n = intIn(rng, 1, 4);
        for (let i = 0; i < n; i++) {
          const kind = intIn(rng, PMEV_STEP, PMEV_LAND);
          pushEntityEvent(
            f.eventSeq,
            f.evKind,
            f.evValue,
            s,
            kind,
            kind === PMEV_JUMP ? 0 : intIn(rng, 0, 255),
          );
        }
      }
      // Otherwise idle this tick.
    }
  }

  /** The live frame as the server captures it at the end of tick `t` (every stamp = t). */
  capture(out: WorldFrame, t: number): void {
    const f = this.live;
    out.clear();
    for (let s = 0; s < SLOTS; s++) {
      if (f.present[s] !== 1) continue;
      copySlot(out, s, f, s);
      out.setPresent(s, t);
    }
  }
}

/** A packet in flight. */
interface Flight {
  at: number;
  bytes: Uint8Array;
  tick: number;
  digest: number;
  ack: number;
}

/** A one-way link: loss, duplication and a jittered delay in ticks (so it reorders). */
class Link {
  private readonly flights: Flight[] = [];
  loss = 0.05;
  duplicate = 0.02;
  minDelay = 4;
  maxDelay = 14;
  constructor(private readonly rng: Mulberry32) {}

  send(now: number, f: Omit<Flight, "at">): void {
    if (this.rng.nextFloat() < this.loss) return;
    const copies = this.rng.nextFloat() < this.duplicate ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      this.flights.push({ ...f, at: now + intIn(this.rng, this.minDelay, this.maxDelay) });
    }
  }

  /** The packets due at `now`, in arrival order. */
  deliver(now: number, out: Flight[]): void {
    out.length = 0;
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i] as Flight;
      if (f.at <= now) {
        out.push(f);
        this.flights.splice(i, 1);
      }
    }
    out.sort((a, b) => a.at - b.at);
  }
}

/**
 * The server's side of one client (M3 design §2.3): its sent ring and the acked baseline. A model
 * of the rule increment 9 puts in the match; until then, assertions on it check the model.
 */
export class ServerSide {
  readonly history = new FrameRing();
  private readonly sentTicks = new Int32Array(SNAPSHOT_HISTORY);
  ackTick = 0;
  newestSent = 0;
  strikes = 0;

  onAck(ack: number, t: number): void {
    if (ack === 0) {
      this.ackTick = 0;
      return;
    }
    if (ack > this.newestSent) {
      this.strikes += 2;
      return;
    }
    if (t - ack > RING || this.sentTicks[ack & RING] !== ack || !this.history.has(ack)) return;
    if (ack > this.ackTick) this.ackTick = ack;
  }

  /** The baseline tick for a snapshot of `t`, or 0 for a full one. */
  baseline(t: number): number {
    const a = this.ackTick;
    if (a <= 0 || t - a > RING || this.sentTicks[a & RING] !== a || !this.history.has(a)) return 0;
    return a;
  }

  sent(t: number): void {
    this.sentTicks[t & RING] = t;
    this.newestSent = t;
  }

  /** Forgets that `t` was sent (a server-side encode failure: never a baseline). */
  unsend(t: number): void {
    if (this.sentTicks[t & RING] === t) this.sentTicks[t & RING] = 0;
  }
}

/** The client store under test, as the driver sees it. */
export interface DeltaStore {
  /** The stored frames (the driver forces misses through it). */
  readonly ring: FrameRing;
  readonly newestTick: number;
  /** What the client's INPUT acks. */
  readonly ackTick: number;
  /** Stores the SNAPSHOT in `bytes` as receiver DELTA_SELF; the stored frame, or null. */
  receive(bytes: Uint8Array): WorldFrame | null;
}

/** What a run did. */
export interface DeltaRun {
  /** Mismatches and broken rules, at most a few kept. */
  readonly failures: string[];
  /** Stored frames equal to the server's (frameDigest). */
  matched: number;
  /** Deltas the server sent, and their bytes against what full snapshots would have taken. */
  deltas: number;
  deltaBytes: number;
  fullEquivalentBytes: number;
  /** The most a delta record or local block took over the full form, in bits. */
  worstEntityOver: number;
  worstLocalOver: number;
  forcedMisses: number;
  /** Times the store started acking 0 after storing something (the 8-drop rule). */
  fullRequests: number;
  /** Fulls the server sent while it held an ack (the ack aged out of the window). */
  fullsAfterValidAck: number;
  hostile: number;
}

/**
 * Runs `ticks` ticks of the seeded world through the server's encoder into `store`. The sequence
 * is the same for every store, so two stores that follow the same rules see the same packets.
 */
export function runDeltaSequence(store: DeltaStore, ticks: number): DeltaRun {
  const rng = new Mulberry32(0xde17a);
  const world = new World(rng);
  const server = new ServerSide();
  const down = new Link(new Mulberry32(0xd0));
  const up = new Link(new Mulberry32(0x0b));
  const w = new BitWriter(MAX_UNRELIABLE_BYTES);
  const hdr = new SnapshotHeader();
  const arrived: Flight[] = [];
  const run: DeltaRun = {
    failures: [],
    matched: 0,
    deltas: 0,
    deltaBytes: 0,
    fullEquivalentBytes: 0,
    worstEntityOver: -Infinity,
    worstLocalOver: -Infinity,
    forcedMisses: 0,
    fullRequests: 0,
    fullsAfterValidAck: 0,
    hostile: 0,
  };
  // Mismatches are collected and asserted once: an expect per tick dominated the run time.
  const failures = run.failures;
  let askingFull = false;
  for (let t = 1; t <= ticks; t++) {
    const phase = t % 4000;
    // Phases: a burst of heavy loss, lost acks past the 63-tick window, a calm stretch.
    down.loss = phase >= 1000 && phase < 1100 ? 0.5 : 0.05;
    up.loss = phase >= 2000 && phase < 2090 ? 1 : 0.05;
    down.duplicate = up.duplicate = phase >= 3000 && phase < 3200 ? 0.3 : 0.02;
    // Acks that arrive now (delayed, reordered, duplicated, lost), plus hostile ones.
    up.deliver(t, arrived);
    for (const a of arrived) server.onAck(a.ack, t);
    if (rng.nextInt(50) === 0) {
      run.hostile++;
      const kind = rng.nextInt(3);
      const strikes = server.strikes;
      const before = server.ackTick;
      if (kind === 0) server.onAck(t + intIn(rng, 1, 1000), t);
      else if (kind === 1) server.onAck(Math.max(1, t - 64 - rng.nextInt(500)), t);
      else server.onAck(server.newestSent + 1, t);
      if (server.ackTick !== before) failures.push(`tick ${t}: a hostile ack moved the baseline`);
      if (kind !== 1 && server.strikes !== strikes + 2) failures.push(`tick ${t}: not struck`);
    }
    world.step(t, phase >= 500 && phase < 600);
    const cur = server.history.slot(t);
    world.capture(cur, t);
    server.history.store(t);
    // The server's snapshot: a delta against the acked baseline whenever it is valid, so baseBack
    // is T − ackTick by construction here (increment 9 asserts it on the match's own rule).
    const baseTick = server.baseline(t);
    if (server.ackTick > 0 && baseTick === 0) run.fullsAfterValidAck++;
    const base = baseTick === 0 ? null : server.history.get(baseTick);
    hdr.serverTick = t;
    hdr.baseBack = baseTick === 0 ? 0 : t - baseTick;
    hdr.flags = 0;
    hdr.cvarHash = t & 0xffff;
    hdr.inputBufferHealth = 2;
    w.reset();
    if (!encodeSnapshot(w, hdr, cur, base, DELTA_SELF)) failures.push(`tick ${t}: did not encode`);
    server.sent(t);
    if (base !== null) {
      run.deltas++;
      run.deltaBytes += w.byteLength;
      run.fullEquivalentBytes +=
        (SNAP_FULL_FIXED_BITS + (cur.presentCount - 1) * ENTITY_NEW_BITS + 7) >> 3;
      run.worstLocalOver = Math.max(
        run.worstLocalOver,
        localBlockBits(cur, base, DELTA_SELF) - 199,
      );
      for (let s = t & 3; s < SLOTS; s += 4) {
        if (s !== DELTA_SELF)
          run.worstEntityOver = Math.max(
            run.worstEntityOver,
            entityRecordBits(cur, base, s) - ENTITY_NEW_BITS,
          );
      }
    }
    down.send(t, {
      bytes: w.bytes.slice(0, w.byteLength),
      tick: t,
      digest: frameDigest(cur, DELTA_SELF),
      ack: 0,
    });
    // Forced misses, alternating: the client loses its newest frame, or all of them while it
    // still acks the newest tick, so deltas miss their baseline until a newer one is stored or 8
    // misses in a row ask for a full snapshot.
    if (t % 2500 === 1700) {
      if (run.forcedMisses % 2 === 0) store.ring.invalidate(store.newestTick);
      else store.ring.clear();
      run.forcedMisses++;
    }
    // The client: stores what arrives, then acks its newest stored tick.
    down.deliver(t, arrived);
    for (const a of arrived) {
      const f = store.receive(a.bytes);
      const asking = store.ackTick === 0 && store.newestTick > 0;
      if (asking && !askingFull) run.fullRequests++;
      askingFull = asking;
      if (f === null) continue;
      if (frameDigest(f, DELTA_SELF) === a.digest) run.matched++;
      else failures.push(`tick ${a.tick}: the stored frame differs from the server's`);
    }
    up.send(t, { bytes: new Uint8Array(0), tick: t, digest: 0, ack: store.ackTick });
  }
  return run;
}
