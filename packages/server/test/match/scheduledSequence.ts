import {
  BitWriter,
  copySlot,
  FRAME_SLOTS,
  frameDigest,
  MAX_SNAPSHOT_BYTES,
  MAX_UNRELIABLE_BYTES,
  Mulberry32,
  SNAP_MAX_STALENESS,
  SNAPSHOT_HISTORY,
  SnapshotHeader,
  WorldFrame,
} from "@game/shared";
import {
  DELTA_SELF,
  type Flight,
  Link,
  StoreModel,
} from "../../../shared/test/helpers/deltaSequence";
import { intIn, mutateLocal, randomEntity } from "../../../shared/test/helpers/netMessages";
import { ACK_AHEAD, acceptAck, baselineTick, WorldHistory } from "../../src/match/history";
import { MirrorPool, sentFrame } from "../../src/match/mirror";
import {
  buildSnapshot,
  resetScheduleState,
  type SnapshotClient,
  SnapshotScheduler,
} from "../../src/match/scheduler";

// NET-02 (a)'s scheduled legs (docs/05 §4.3, §14; M3 design §2.3 and §5, D-046): a seeded world of
// up to 64 slots goes through the match's own snapshot build (`buildSnapshot`: baseline, mirror,
// byte-budget scheduler, encoder, commit) into a model of the client's store (`StoreModel`, the
// rules `client/test/net/net-02-store.test.ts` pins on the real store) over impaired links both
// ways, and every snapshot and every stored frame is checked against the design's rules.

/** A client of the driver: what the match keeps per session for its snapshots. */
export class DriverClient implements SnapshotClient {
  readonly sentTicks = new Int32Array(SNAPSHOT_HISTORY);
  newestSent = 0;
  ackTick = 0;
  readonly lastSent = new Int32Array(FRAME_SLOTS);
  readonly lastDeferred = new Int32Array(FRAME_SLOTS);
  readonly sentSerial = new Int32Array(FRAME_SLOTS);
  mirror: SnapshotClient["mirror"] = null;
  constructor() {
    resetScheduleState(this);
  }
}

/** The players of the world, every slot's serial and its live state. */
export class SlotWorld {
  readonly live = new WorldFrame();
  private readonly serials = new Uint16Array(FRAME_SLOTS);
  constructor(readonly rng: Mulberry32) {}

  join(s: number, t: number): void {
    const f = this.live;
    const teleportSeq = f.teleportSeq[s] as number;
    randomEntity(this.rng, f, s, t);
    mutateLocal(this.rng, f, s);
    this.serials[s] = ((this.serials[s] as number) + 1) & 0xffff;
    f.serial[s] = this.serials[s] as number;
    f.teleportSeq[s] = (teleportSeq + 1) & 0xff;
  }

  leave(s: number): void {
    this.live.setAbsent(s);
  }

  /**
   * Every entity field of slot `s` changed to a far value (origin and velocity absolute), so its
   * delta record is the largest, 233 bits: the scheduler's worst class.
   */
  worst(s: number): void {
    const f = this.live;
    const rng = this.rng;
    const flip = (v: number, max: number) =>
      v > 0 ? -max + rng.nextInt(64) : max - rng.nextInt(64);
    f.originX[s] = flip(f.originX[s] as number, 524288);
    f.originY[s] = flip(f.originY[s] as number, 524288);
    f.originZ[s] = flip(f.originZ[s] as number, 524288);
    f.entVelX[s] = flip(f.entVelX[s] as number, 32767);
    f.entVelY[s] = flip(f.entVelY[s] as number, 32767);
    f.entVelZ[s] = flip(f.entVelZ[s] as number, 32767);
    f.yaw[s] = ((f.yaw[s] as number) + 1 + rng.nextInt(1000)) & 0xffff;
    f.pitch[s] = (f.pitch[s] as number) > 0 ? -100 - rng.nextInt(100) : 100 + rng.nextInt(100);
    f.flags[s] = ((f.flags[s] as number) & 0x39f) ^ 1;
    f.team[s] = ((f.team[s] as number) % 2) + 1;
    f.teleportSeq[s] = ((f.teleportSeq[s] as number) + 1) & 0xff;
    f.eventSeq[s] = ((f.eventSeq[s] as number) + 1) & 0xff;
    f.evKind[s * 2] = 1;
    f.evValue[s * 2] = rng.nextInt(256);
    f.evKind[s * 2 + 1] = 0;
    f.evValue[s * 2 + 1] = 0;
  }

  /** The receiver's own state changed (the local block). */
  moveSelf(s: number): void {
    mutateLocal(this.rng, this.live, s);
  }

  capture(out: WorldFrame, t: number): void {
    const f = this.live;
    out.clear();
    for (let s = 0; s < FRAME_SLOTS; s++) {
      if (f.present[s] !== 1) continue;
      copySlot(out, s, f, s);
      out.setPresent(s, t);
    }
  }
}

export interface ScheduledOptions {
  readonly ticks: number;
  readonly seed: number;
  /** One tick of the world: joins, leaves, moves. */
  readonly step: (world: SlotWorld, t: number) => void;
  /** Impaired links (loss, duplication, reorder, lost acks, hostile acks, forced misses). */
  readonly impaired: boolean;
  /** Ack delay range in ticks (both links), default 4–14. */
  readonly delay?: readonly [number, number];
}

export interface ScheduledRun {
  readonly failures: string[];
  snapshots: number;
  /** Snapshots that left a player out (deferred ids or dropped reused slots). */
  deferredSnapshots: number;
  deferredIds: number;
  dropped: number;
  sizePasses: number;
  maxBytes: number;
  maxStaleness: number;
  overflow: number;
  overrun: number;
  matched: number;
  /** Stored frames the client decoded against a mirrored (non-plain) baseline. */
  mirroredBaselines: number;
  /** The oldest baseline a mirrored snapshot was coded against, ticks back. */
  maxBaseBack: number;
  readonly store: StoreModel;
  readonly pool: MirrorPool;
}

/**
 * Runs the scheduled sequence: per tick the acks that arrived (and now and then a hostile one),
 * the world's step, its capture, the client's snapshot through `buildSnapshot`, the checks of
 * M3 design §5 NET-02 on what was sent, and the client storing what arrives and acking its newest.
 */
export function runScheduled(o: ScheduledOptions): ScheduledRun {
  const rng = new Mulberry32(o.seed);
  const world = new SlotWorld(new Mulberry32(o.seed ^ 0x5eed));
  const history = new WorldHistory();
  const client = new DriverClient();
  const pool = new MirrorPool();
  client.mirror = pool.acquire();
  const sched = new SnapshotScheduler();
  const store = new StoreModel();
  const down = new Link(new Mulberry32(o.seed ^ 0xd0));
  const up = new Link(new Mulberry32(o.seed ^ 0x0b));
  const [minDelay, maxDelay] = o.delay ?? [4, 14];
  down.minDelay = up.minDelay = minDelay;
  down.maxDelay = up.maxDelay = maxDelay;
  if (!o.impaired) down.loss = up.loss = down.duplicate = up.duplicate = 0;
  const w = new BitWriter(MAX_UNRELIABLE_BYTES);
  const hdr = new SnapshotHeader();
  const arrived: Flight[] = [];
  const self = DELTA_SELF;
  world.join(self, 0);
  const run: ScheduledRun = {
    failures: [],
    snapshots: 0,
    deferredSnapshots: 0,
    deferredIds: 0,
    dropped: 0,
    sizePasses: 0,
    maxBytes: 0,
    maxStaleness: 0,
    overflow: 0,
    overrun: 0,
    matched: 0,
    mirroredBaselines: 0,
    maxBaseBack: 0,
    store,
    pool,
  };
  const fail = (msg: string) => {
    if (run.failures.length < 8) run.failures.push(msg);
  };
  // Per slot: sent snapshots in a row that left the player out, and in a row without its state.
  const leftRun = new Int32Array(FRAME_SLOTS);
  const statelessRun = new Int32Array(FRAME_SLOTS);
  // Per slot: the serial of the player last sent fresh there (−1: none yet).
  const freshSerial = new Int32Array(FRAME_SLOTS).fill(-1);
  const mirrored = new Int32Array(SNAPSHOT_HISTORY);
  for (let t = 1; t <= o.ticks; t++) {
    if (o.impaired) {
      const phase = t % 2000;
      down.loss = phase >= 600 && phase < 660 ? 0.5 : 0.05;
      up.loss = phase >= 1200 && phase < 1290 ? 1 : 0.05;
    }
    up.deliver(t, arrived);
    for (const a of arrived) acceptAck(client, a.ack, t, history);
    if (o.impaired && rng.nextInt(50) === 0) {
      const before = client.ackTick;
      const kind = rng.nextInt(3);
      const ack = kind === 0 ? t + intIn(rng, 1, 1000) : client.newestSent + 1;
      if (kind === 2) acceptAck(client, 0, t, history);
      else if (acceptAck(client, ack, t, history) !== ACK_AHEAD) fail(`tick ${t}: not ahead`);
      else if (client.ackTick !== before) fail(`tick ${t}: a hostile ack moved the baseline`);
    }
    o.step(world, t);
    world.capture(history.frameFor(t), t);
    history.stored(t);
    const cur = history.frameFor(t);
    const b = baselineTick(client, t, history);
    if (b !== 0 && b !== client.ackTick) fail(`tick ${t}: baseBack is not T − ackTick`);
    const base = b === 0 ? null : sentFrame(history, client.mirror, b);
    hdr.flags = 0;
    hdr.cvarHash = t & 0xffff;
    hdr.inputBufferHealth = 2;
    const ok = buildSnapshot(sched, w, hdr, history, client, self, t, null);
    if (sched.sizePass) run.sizePasses++;
    if (sched.overrun) run.overrun++;
    if (!ok) {
      run.overflow++;
      fail(`tick ${t}: the snapshot did not encode`);
      continue;
    }
    run.snapshots++;
    run.maxBytes = Math.max(run.maxBytes, w.byteLength);
    if (w.byteLength > MAX_SNAPSHOT_BYTES) fail(`tick ${t}: ${w.byteLength} B`);
    run.maxStaleness = Math.max(run.maxStaleness, sched.maxStaleness);
    if (sched.maxStaleness > SNAP_MAX_STALENESS) fail(`tick ${t}: staleness ${sched.maxStaleness}`);
    const left = sched.deferred + sched.dropped;
    if (left > 0) run.deferredSnapshots++;
    run.deferredIds += sched.deferred;
    run.dropped += sched.dropped;
    const sent = sentFrame(history, client.mirror, t) as WorldFrame;
    mirrored[t & 63] = left > 0 ? t : 0;
    if (b !== 0 && mirrored[b & 63] === b) {
      run.mirroredBaselines++;
      run.maxBaseBack = Math.max(run.maxBaseBack, t - b);
    }
    for (let s = 0; s < FRAME_SLOTS; s++) {
      if (s === self) continue;
      if (cur.present[s] !== 1) {
        // A player who left is gone from the client's frame at once: removals are never deferred.
        if (sent.present[s] === 1) fail(`tick ${t}: slot ${s} left but is still in the frame`);
        leftRun[s] = 0;
        statelessRun[s] = 0;
        continue;
      }
      const fresh = sent.present[s] === 1 && sent.stamp[s] === t;
      const hasState = sent.present[s] === 1 && sent.stamp[s] !== 0;
      // A player the client was sent never blinks out while still there (a reused slot's new
      // player while the ack still holds the old one ranks above the other undue records).
      if (sent.present[s] !== 1 && freshSerial[s] === cur.serial[s]) {
        fail(`tick ${t}: slot ${s}'s player, already sent, blinks out`);
      }
      if (fresh) freshSerial[s] = cur.serial[s] as number;
      if (hasState && sent.serial[s] !== cur.serial[s]) {
        fail(`tick ${t}: slot ${s} shows a departed player's state`);
      }
      if (sent.present[s] === 1 && sent.stamp[s] === 0 && base !== null) {
        if (base.present[s] === 1 && base.stamp[s] !== 0) {
          fail(`tick ${t}: slot ${s} pending though the baseline holds its state`);
        }
      }
      leftRun[s] = fresh ? 0 : (leftRun[s] as number) + 1;
      statelessRun[s] = hasState ? 0 : (statelessRun[s] as number) + 1;
      if ((leftRun[s] as number) > 1) fail(`tick ${t}: slot ${s} left out twice in a row`);
      if ((statelessRun[s] as number) > 1) fail(`tick ${t}: slot ${s} without state twice`);
    }
    down.send(t, {
      bytes: w.bytes.slice(0, w.byteLength),
      tick: t,
      digest: frameDigest(sent, self),
      ack: 0,
    });
    if (o.impaired && t % 1500 === 900) store.ring.invalidate(store.newestTick);
    down.deliver(t, arrived);
    for (const a of arrived) {
      const f = store.receive(a.bytes);
      if (f === null) continue;
      if (frameDigest(f, self) === a.digest) run.matched++;
      else fail(`tick ${a.tick}: the stored frame differs from the server's`);
    }
    up.send(t, { bytes: new Uint8Array(0), tick: t, digest: 0, ack: store.ackTick });
  }
  return run;
}

/** Ids 0…n − 1 present (the receiver among them), each moving at its worst every tick. */
export function worstCrowd(n: number): (world: SlotWorld, t: number) => void {
  return (world, t) => {
    for (let s = 0; s < n; s++) {
      if (world.live.present[s] !== 1) world.join(s, t);
      else if (s === DELTA_SELF) world.moveSelf(s);
      else world.worst(s);
    }
  };
}
