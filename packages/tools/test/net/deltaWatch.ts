import { SESSION_ACTIVE } from "@game/server";
import {
  ENTITY_NEW_BITS,
  entityRecordBits,
  FRAME_SLOTS,
  localBlockBits,
  PLAYER_STATE_BITS,
  SNAP_FULL_FIXED_BITS,
  SNAPSHOT_HISTORY,
  TICK_RATE,
} from "@game/shared";
import type { HarnessClient, MultiHarness } from "./multiHarness";

/**
 * The watch's own account of one session (D-038), kept apart from the match's: the ticks of the
 * snapshots its tap saw go out, and the ack those and the INPUTs reaching the match earn by the
 * rule of docs/05 §4.3.
 */
class AckModel {
  readonly sent = new Int32Array(SNAPSHOT_HISTORY);
  newestSent = 0;
  ack = 0;
  /** Acks past the newest snapshot sent (each worth 2 strikes). */
  ahead = 0;
}

/**
 * Watches every snapshot a harness match sends, after every server tick (M3 design §5 NET-02 (b),
 * D-038): it must be a delta against the client's acked tick whenever that tick is a usable
 * baseline (baseBack = T − ackTick), and full otherwise. The ack is derived here, apart from the
 * match's rule: from the `lastSnapshotTick` of every INPUT that reaches the match (the session
 * tap's `onInputAck`) and the snapshot ticks the tap saw go out (ack 0 drops the baseline; one
 * past the newest sent, older than the baseline, more than 63 ticks back or never sent is
 * ignored), and checked against the session's `ackTick` every tick. It also sizes
 * every delta's records against their full forms (per entity at most a new body + 20 bits, the
 * local block at most the full state + 20) and counts the deltas, their bytes and what full
 * snapshots of the same frames would have taken. Clients' frames are checked against the server's
 * by the harness itself (recording clients, `frameDigest`).
 */
export class DeltaWatch {
  /** Broken rules, the first few kept. */
  readonly failures: string[] = [];
  snapshots = 0;
  deltas = 0;
  deltaBytes = 0;
  /** What the deltas would have taken as full snapshots of the same frames. */
  fullEquivalentBytes = 0;
  /** The most a delta record or local block took over its full form, bits. */
  worstEntityOver = Number.NEGATIVE_INFINITY;
  worstLocalOver = Number.NEGATIVE_INFINITY;
  /** Snapshots from `warmTicks` after each client's spawn on, and the deltas among them. */
  warmSnapshots = 0;
  warmDeltas = 0;
  /** Snapshots sent while the client held a usable ack, but full (must stay 0). */
  fullsWithBaseline = 0;
  /** The largest baseBack sent, and the deltas sent 32 or more ticks back. */
  maxBaseBack = 0;
  oldDeltas = 0;
  private readonly models = new Map<HarnessClient, AckModel>();

  /**
   * `warmTicks`: ticks after a spawn before the delta share counts (the first RTT after READY,
   * when no ack can have arrived yet). Chains the harness's `afterServerTick`.
   */
  constructor(
    private readonly h: MultiHarness,
    private readonly warmTicks: number,
  ) {
    const before = h.afterServerTick;
    h.afterServerTick = () => {
      before?.();
      this.check();
    };
  }

  /** The delta share of the snapshots past each client's first RTT. */
  get warmDeltaShare(): number {
    return this.warmSnapshots === 0 ? 0 : this.warmDeltas / this.warmSnapshots;
  }

  /** A one-line account for a test's log. */
  describe(): string {
    const mean = this.deltas === 0 ? 0 : this.deltaBytes / this.deltas;
    const full = this.deltas === 0 ? 0 : this.fullEquivalentBytes / this.deltas;
    return (
      `${this.snapshots} snapshots, ${this.deltas} deltas (${(100 * this.warmDeltaShare).toFixed(1)}% ` +
      `after the first RTT), mean delta ${mean.toFixed(0)} B vs ${full.toFixed(0)} B full; worst ` +
      `record ${this.worstEntityOver} and local block ${this.worstLocalOver} bits over full`
    );
  }

  private fail(text: string): void {
    if (this.failures.length < 8) this.failures.push(text);
  }

  private check(): void {
    const h = this.h;
    const match = h.match;
    const t = match.serverTick;
    const history = match.history;
    const cur = history.get(t);
    if (cur === null) return;
    const clients = h.clients;
    for (let i = 0; i < clients.length; i++) {
      const c = clients[i] as HarnessClient;
      const s = c.session;
      if (s === null || match.session(s.clientId) !== s) continue;
      let m = this.models.get(c);
      if (m === undefined) {
        // Before the session is active the match takes no ack, so none can have been missed.
        if (s.state === SESSION_ACTIVE) this.fail(`client ${s.clientId}: watched too late`);
        m = this.watchAcks(c);
      }
      if (s.state !== SESSION_ACTIVE) continue;
      // Every active session gets a snapshot of every tick (an encode that failed sends none).
      if (c.tap.lastSnapshotTick !== t) {
        this.fail(`client ${s.clientId} tick ${t}: no snapshot (ack ${m.ack})`);
        continue;
      }
      this.snapshots++;
      const ack = m.ack;
      if (ack !== s.ackTick) {
        this.fail(`client ${s.clientId} tick ${t}: ackTick ${s.ackTick}, want ${ack}`);
      }
      // `ack` was taken only within 63 ticks of a sent snapshot, so the history holds it until
      // it is more than 63 ticks back.
      const usable =
        ack > 0 && t - ack < SNAPSHOT_HISTORY && m.sent[ack % SNAPSHOT_HISTORY] === ack;
      m.sent[t % SNAPSHOT_HISTORY] = t;
      m.newestSent = t;
      const want = usable ? t - ack : 0;
      const got = c.tap.lastBaseBack;
      if (got !== want) {
        this.fail(`client ${s.clientId} tick ${t}: baseBack ${got}, want ${want} (ack ${ack})`);
      }
      const warm = t >= s.spawnTick + this.warmTicks;
      if (warm) this.warmSnapshots++;
      if (!usable) continue;
      if (got === 0) this.fullsWithBaseline++;
      const base = history.get(ack);
      if (base === null) {
        this.fail(`client ${s.clientId} tick ${t}: the history lost tick ${ack}`);
        continue;
      }
      this.deltas++;
      if (warm) this.warmDeltas++;
      this.maxBaseBack = Math.max(this.maxBaseBack, t - ack);
      if (t - ack >= 32) this.oldDeltas++;
      this.deltaBytes += c.tap.lastSnapshotBytes;
      this.fullEquivalentBytes +=
        (SNAP_FULL_FIXED_BITS + (cur.presentCount - 1) * ENTITY_NEW_BITS + 7) >> 3;
      const self = s.clientId;
      this.worstLocalOver = Math.max(
        this.worstLocalOver,
        localBlockBits(cur, base, self) - PLAYER_STATE_BITS,
      );
      for (let e = 0; e < FRAME_SLOTS; e++) {
        if (e === self || (cur.present[e] !== 1 && base.present[e] !== 1)) continue;
        this.worstEntityOver = Math.max(
          this.worstEntityOver,
          entityRecordBits(cur, base, e) - ENTITY_NEW_BITS,
        );
      }
    }
  }

  /** Follows the acks that reach the match for `c`'s session, by docs/05 §4.3's rule. */
  private watchAcks(c: HarnessClient): AckModel {
    const m = new AckModel();
    this.models.set(c, m);
    const match = this.h.match;
    c.tap.onInputAck = (ack) => {
      const s = c.session;
      if (s === null || s.state !== SESSION_ACTIVE) return;
      // Read during the poll of the tick about to be simulated.
      const t = match.serverTick + 1;
      if (ack === 0) {
        m.ack = 0;
      } else if (ack > m.newestSent) {
        m.ahead++;
      } else if (
        ack > m.ack &&
        t - ack < SNAPSHOT_HISTORY &&
        m.sent[ack % SNAPSHOT_HISTORY] === ack
      ) {
        m.ack = ack;
      }
    };
    return m;
  }

  /** Acks past the newest snapshot sent, all sessions (an honest client sends none). */
  get acksAhead(): number {
    let n = 0;
    for (const m of this.models.values()) n += m.ahead;
    return n;
  }
}

/** Ticks in `ms` (rounded up), for a warm-up given as a time. */
export function ticksIn(ms: number): number {
  return Math.ceil((ms * TICK_RATE) / 1000);
}
