import {
  type CollisionWorld,
  type CvarRegistry,
  copyPlayerState,
  copyUserCmd,
  cvarHash16,
  diffPlayerState,
  PlayerState,
  PlayerStateRing,
  PmoveEvents,
  PmoveParams,
  type PmoveTraceLog,
  playerStateEquals,
  pmove,
  refreshPmoveParams,
  sanitizeUserCmd,
  TICK_DT,
  TICK_MAX,
  UserCmd,
  type Vec3,
} from "@game/shared";

/** Cmds the predictor keeps, like the state ring: 128 ticks, about 2.1 s (M2 design §2). */
export const CMD_RING_CAPACITY = 128;
const CMD_MASK = CMD_RING_CAPACITY - 1;

/** Corrections the log keeps (M2 design §2). */
export const CORRECTION_LOG_CAPACITY = 32;

/** What `Predictor.onSnapshot` did with a snapshot. */
export const SNAPSHOT_STALE = 0;
/** The prediction for the snapshot's tick was exact. */
export const SNAPSHOT_MATCHED = 1;
/** The prediction was wrong: the state was adopted and the ticks after it re-simulated. */
export const SNAPSHOT_CORRECTED = 2;
/**
 * The server simulated the tick with cvars the client had not switched to yet (its cvar hash
 * differs): the state was adopted and re-simulated, but it is not counted as a correction.
 */
export const SNAPSHOT_PARAMS_RESYNC = 3;
/**
 * The tick is no longer (or not yet) in the rings, so nothing can be re-simulated: the state was
 * adopted as the newest tick, and the caller re-anchors its clock.
 */
export const SNAPSHOT_HARD_RESYNC = 4;
/**
 * The snapshot's teleport counter changed (a spawn or respawn, D-035): the state was adopted and
 * the ticks after it re-simulated, and the caller drops its render offset. Not a correction: the
 * server moved the player on purpose, so the prediction could not have known.
 */
export const SNAPSHOT_TELEPORT = 5;

/** The last CMD_RING_CAPACITY cmds by tick; slots remember their tick, like PlayerStateRing. */
export class CmdRing {
  private readonly slots: UserCmd[] = [];
  private readonly ticks = new Int32Array(CMD_RING_CAPACITY).fill(-1);

  constructor() {
    for (let i = 0; i < CMD_RING_CAPACITY; i++) this.slots.push(new UserCmd());
  }

  /** Stores a copy of `cmd` under `cmd.tick`. */
  write(cmd: UserCmd): void {
    const i = cmd.tick & CMD_MASK;
    copyUserCmd(this.slots[i] as UserCmd, cmd);
    this.ticks[i] = cmd.tick;
  }

  /** The stored cmd for `tick` (owned by the ring; valid until the slot is reused), or null. */
  get(tick: number): UserCmd | null {
    if (tick < 0 || tick > TICK_MAX) return null;
    const i = tick & CMD_MASK;
    return this.ticks[i] === tick ? (this.slots[i] as UserCmd) : null;
  }

  has(tick: number): boolean {
    return tick >= 0 && tick <= TICK_MAX && this.ticks[tick & CMD_MASK] === tick;
  }

  clear(): void {
    this.ticks.fill(-1);
  }
}

/**
 * One logged correction. The states are kept, not their diff, so logging allocates nothing;
 * `diff()` builds the "field: predicted → server" lines when someone reads the log.
 */
export class CorrectionRecord {
  /** The snapshot tick whose state differed. */
  tick = 0;
  /** The newest predicted tick, re-simulated. */
  latestTick = 0;
  /** How far the newest predicted origin moved, u. */
  distance = 0;
  readonly predicted = new PlayerState();
  readonly server = new PlayerState();

  diff(): string[] {
    return diffPlayerState(this.predicted, this.server);
  }
}

/** The last CORRECTION_LOG_CAPACITY corrections, oldest first by `at(0)`. */
export class CorrectionLog {
  private readonly records: CorrectionRecord[] = [];
  private next = 0;
  /** Corrections logged since the last clear (the log holds the newest CAPACITY of them). */
  total = 0;

  constructor() {
    for (let i = 0; i < CORRECTION_LOG_CAPACITY; i++) this.records.push(new CorrectionRecord());
  }

  get count(): number {
    return Math.min(this.total, CORRECTION_LOG_CAPACITY);
  }

  /** The record to fill for a new correction. */
  push(): CorrectionRecord {
    const r = this.records[this.next] as CorrectionRecord;
    this.next = (this.next + 1) % CORRECTION_LOG_CAPACITY;
    this.total++;
    return r;
  }

  /** The i-th held record, oldest first. */
  at(i: number): CorrectionRecord {
    const start = this.total > CORRECTION_LOG_CAPACITY ? this.next : 0;
    return this.records[(start + i) % CORRECTION_LOG_CAPACITY] as CorrectionRecord;
  }

  clear(): void {
    this.total = 0;
    this.next = 0;
  }
}

/**
 * Client prediction and reconciliation of the local player (docs/05 §5, M2 design §2): the
 * shared pmove on the replicated parameters, a ring of cmds and of predicted states, and the
 * snapshot check.
 *
 * - `predict(cmd)` sanitizes the cmd (the server sanitizes what it receives too, and sanitizing is
 *   idempotent), stores it, runs pmove from the newest predicted state and stores the result.
 *   Movement events and the trace log are recorded here only, on a tick's first prediction.
 * - `onSnapshot` compares the server's state for tick A with the prediction for A using exact
 *   equality. On a mismatch it adopts the server's state and re-simulates A+1 … latest from the
 *   stored cmds, each tick with the parameters in force at that tick. A changed teleport counter
 *   (D-035) adopts and re-simulates the same way, as a teleport rather than a correction; only
 *   snapshots past the newest one move the counter, so a lost spawn snapshot still shows as a
 *   teleport on the next one and a reordered older one never steps it back.
 * - Parameters switch by tick (D-027): `setPendingParams` loads a CVARS block for ticks from its
 *   effective tick on and re-simulates at once from the newest snapshot, so a live cvar change
 *   costs no correction on a lossless link. The pending set is promoted once a snapshot reaches
 *   its effective tick.
 *
 * Nothing allocates per tick or per snapshot, corrections included.
 */
export class Predictor {
  readonly cmds = new CmdRing();
  readonly states = new PlayerStateRing();
  /** The newest predicted state (tick `latestTick`). */
  readonly state = new PlayerState();
  /** Newest predicted tick; −1 before the first snapshot. */
  latestTick = -1;
  /** The newest snapshot's state and tick (−1 before the first). */
  readonly snapshot = new PlayerState();
  snapshotTick = -1;
  /** Movement events of the ticks predicted for the first time since the caller last cleared it. */
  readonly events = new PmoveEvents();
  /** Trace log for debug draw, filled on first predictions only; null = off. */
  traceLog: PmoveTraceLog | null = null;
  readonly corrections = new CorrectionLog();
  /** [0] distance of the last correction, u. */
  readonly lastCorrection = new Float64Array(1);
  /**
   * The newest snapshot's teleport counter (D-035); −1 until a snapshot seeds it (the caller sets
   * it from the spawn snapshot, or the first `onSnapshot` does).
   */
  teleportSeq = -1;
  /** Teleport-counter changes seen (none for the snapshot that seeds it). */
  teleports = 0;

  /** Parameters in force, their block's low 16 hash bits. */
  private params = new PmoveParams();
  private hash16 = -1;
  /** Parameters from `pendingFromTick` on, when `hasPending`. */
  private pending = new PmoveParams();
  private pendingHash16 = -1;
  private pendingFromTick = 0;
  private hasPending = false;

  private readonly scratch = new PlayerState();
  private readonly oldLatest = new Float64Array(3);

  /** The map's collision; `ClientSim.provideMap` sets it when the map arrives after WELCOME. */
  constructor(public world: CollisionWorld) {}

  /** The parameters for `tick`. */
  paramsFor(tick: number): PmoveParams {
    return this.hasPending && tick >= this.pendingFromTick ? this.pending : this.params;
  }

  /** The cvar hash (low 16 bits) the server should report for `tick`. */
  hashFor(tick: number): number {
    return this.hasPending && tick >= this.pendingFromTick ? this.pendingHash16 : this.hash16;
  }

  get pendingParams(): boolean {
    return this.hasPending;
  }

  /** WELCOME: the parameters in force are the mirror's values; `blockHash` is their u32 hash. */
  setParams(mirror: CvarRegistry, blockHash: number): void {
    this.params.version = -1;
    refreshPmoveParams(mirror, this.params);
    this.hash16 = cvarHash16(blockHash);
    this.hasPending = false;
  }

  /**
   * CVARS: the mirror now holds values the server simulates from `fromTick` on. Ticks from there
   * use them; the prediction is re-simulated from the newest snapshot at once. Returns false
   * when that is impossible (no snapshot, or cmds no longer held): the next snapshot resyncs.
   *
   * A second CVARS before the first takes effect replaces it: the ticks between the two effective
   * ticks then keep the parameters in force before either block, so their snapshots resync
   * (counted, not corrections).
   */
  setPendingParams(mirror: CvarRegistry, blockHash: number, fromTick: number): boolean {
    const p = this.pending;
    p.version = -1;
    refreshPmoveParams(mirror, p);
    this.pendingHash16 = cvarHash16(blockHash);
    this.pendingFromTick = fromTick;
    this.hasPending = true;
    if (this.snapshotTick >= fromTick) this.promote();
    if (this.snapshotTick < 0 || !this.canResimulateFrom(this.snapshotTick)) return false;
    this.resimulate(this.snapshotTick, this.snapshot);
    return true;
  }

  private promote(): void {
    const old = this.params;
    this.params = this.pending;
    this.pending = old;
    this.hash16 = this.pendingHash16;
    this.hasPending = false;
  }

  /** Starts predicting from the server's state `s` at `tick` (first snapshot, hard resync). */
  reset(tick: number, s: PlayerState): void {
    this.cmds.clear();
    this.states.clear();
    copyPlayerState(this.state, s);
    copyPlayerState(this.snapshot, s);
    this.states.write(tick, s);
    this.latestTick = tick;
    this.snapshotTick = tick;
    if (this.hasPending && tick >= this.pendingFromTick) this.promote();
  }

  /** Predicts `cmd.tick`, which must be latestTick + 1. `cmd` is sanitized in place. */
  predict(cmd: UserCmd): void {
    sanitizeUserCmd(cmd);
    const tick = cmd.tick;
    this.cmds.write(cmd);
    pmove(this.state, cmd, this.world, this.paramsFor(tick), TICK_DT, this.events, this.traceLog);
    this.states.write(tick, this.state);
    this.latestTick = tick;
  }

  /** Whether every cmd after `tick` up to the newest is still held. */
  private canResimulateFrom(tick: number): boolean {
    if (tick > this.latestTick || this.latestTick - tick >= CMD_RING_CAPACITY) return false;
    return this.states.has(tick) || tick === this.snapshotTick;
  }

  /** Sets tick `from` to `s` and predicts from+1 … latestTick again from the stored cmds. */
  private resimulate(from: number, s: PlayerState): void {
    const st = this.state;
    copyPlayerState(st, s);
    this.states.write(from, st);
    for (let t = from + 1; t <= this.latestTick; t++) {
      const cmd = this.cmds.get(t);
      if (cmd === null) break;
      pmove(st, cmd, this.world, this.paramsFor(t), TICK_DT, null, null);
      this.states.write(t, st);
    }
  }

  /**
   * Reconciles with the server's state `s` for `tick`, simulated with cvar hash `hash16`, whose
   * teleport counter is `teleportSeq`. Returns a SNAPSHOT_* code; a correction is logged and its
   * distance left in `lastCorrection[0]`. A changed counter counts in `teleports` whatever the
   * code (a hard or parameter resync adopts the state too).
   */
  onSnapshot(tick: number, s: PlayerState, hash16: number, teleportSeq: number): number {
    if (tick <= this.snapshotTick) return SNAPSHOT_STALE;
    let teleported = false;
    if (teleportSeq !== this.teleportSeq) {
      teleported = this.teleportSeq >= 0;
      if (teleported) this.teleports++;
      this.teleportSeq = teleportSeq;
    }
    const expectedHash = this.hashFor(tick);
    copyPlayerState(this.snapshot, s);
    this.snapshotTick = tick;
    if (tick > this.latestTick || this.latestTick - tick >= CMD_RING_CAPACITY) {
      this.reset(tick, s);
      return SNAPSHOT_HARD_RESYNC;
    }
    const held = this.states.read(tick, this.scratch);
    let result = SNAPSHOT_MATCHED;
    if (hash16 !== expectedHash) {
      result = SNAPSHOT_PARAMS_RESYNC;
    } else if (!held) {
      this.reset(tick, s);
      return SNAPSHOT_HARD_RESYNC;
    } else if (teleported) {
      result = SNAPSHOT_TELEPORT;
    } else if (!playerStateEquals(this.scratch, s)) {
      result = SNAPSHOT_CORRECTED;
    }
    if (this.hasPending && tick >= this.pendingFromTick && hash16 === this.pendingHash16) {
      this.promote();
    }
    if (result === SNAPSHOT_MATCHED) return result;
    const o = this.state.origin;
    const old = this.oldLatest;
    old[0] = o[0] as number;
    old[1] = o[1] as number;
    old[2] = o[2] as number;
    this.resimulate(tick, s);
    if (result === SNAPSHOT_CORRECTED) {
      const dx = (o[0] as number) - (old[0] as number);
      const dy = (o[1] as number) - (old[1] as number);
      const dz = (o[2] as number) - (old[2] as number);
      this.lastCorrection[0] = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const rec = this.corrections.push();
      rec.tick = tick;
      rec.latestTick = this.latestTick;
      rec.distance = this.lastCorrection[0] as number;
      copyPlayerState(rec.predicted, this.scratch);
      copyPlayerState(rec.server, s);
    }
    return result;
  }

  /** The predicted origin at `tick` into `out`; false when the tick isn't held. */
  originAt(tick: number, out: Vec3): boolean {
    if (!this.states.read(tick, this.scratch)) return false;
    out.set(this.scratch.origin);
    return true;
  }

  /** The predicted state at `tick` into `out`; false when the tick isn't held. */
  stateAt(tick: number, out: PlayerState): boolean {
    return this.states.read(tick, out);
  }
}
