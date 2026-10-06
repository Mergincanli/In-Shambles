import {
  applyCvarBlock,
  BUTTON_ATTACK,
  buildCollisionWorld,
  type Cmap,
  type CollisionWorld,
  CvarRegistry,
  type CvarsMsg,
  copyUserCmd,
  cvarBlockHash,
  type PlayerState,
  registerPmoveCvars,
  SNAP_FLAG_STARVED,
  SNAP_FLAG_TELEPORT,
  type SnapshotMsg,
  type Transport,
  UserCmd,
  type Vec3,
  vec3,
  type WelcomeMsg,
} from "@game/shared";
import { ClientClock, TICK_MS } from "./clock";
import {
  CONN_ACTIVE,
  CONN_CLOSED,
  CONN_SPAWNING,
  Connection,
  type ConnectionHandler,
} from "./connection";
import { ClientNetSettings, refreshClientNetSettings, registerClientNetCvars } from "./cvars";
import {
  Predictor,
  SNAPSHOT_CORRECTED,
  SNAPSHOT_HARD_RESYNC,
  SNAPSHOT_PARAMS_RESYNC,
  SNAPSHOT_STALE,
} from "./predictor";
import { RenderOffset } from "./smoothing";
import {
  NetStats,
  STAT_CLOCK_ADJUSTMENTS,
  STAT_CORRECTION_DIST,
  STAT_CORRECTION_MAX,
  STAT_CORRECTIONS,
  STAT_HARD_RESYNCS,
  STAT_PARAM_RESYNCS,
  STAT_SNAPSHOTS,
  STAT_SNAPSHOTS_LOST,
  STAT_STARVED,
} from "./stats";

/**
 * Prediction ticks one frame may run (docs/05 §8.1's catch-up cap, on the client; design). The
 * rest stays owed to later frames: the client's tick follows the server's clock, so time it drops
 * is lead lost for good.
 */
export const MAX_TICKS_PER_FRAME = 5;
/**
 * The clock never leads a snapshot by more than this many ticks (half the rings, and the server's
 * input queue horizon; design). The prediction also stops this far past the newest snapshot, so a
 * server or link stall never runs it out of the rings or past the cmds the server can queue.
 */
export const MAX_LEAD_TICKS = 64;
/** A snapshot cvar hash that stays different this long asks the server for the block (design). */
export const CVAR_RESEND_AFTER_MS = 1000;

/**
 * Where a tick's cmd comes from: the input sampler in the browser, a script in tests and bots.
 * `sample` fills every field but `tick` from the state the tick starts from (the newest predicted
 * state); out-of-range values are fine, the predictor sanitizes them.
 */
export interface CmdSampler {
  sample(cmd: UserCmd, ps: Readonly<PlayerState>): void;
}

/** Holds still, facing wherever the player faces. */
export class NeutralInput implements CmdSampler {
  sample(cmd: UserCmd, ps: Readonly<PlayerState>): void {
    cmd.buttons = 0;
    cmd.forward = 0;
    cmd.right = 0;
    cmd.up = 0;
    cmd.yaw = ps.viewYaw;
    cmd.pitch = ps.viewPitch;
    cmd.weaponSlot = 0;
  }
}

export type ClientLog = (level: "info" | "warn" | "error", msg: string) => void;

export interface ClientSimOptions {
  readonly transport: Transport;
  /** The map this client has loaded; WELCOME must name it, with the same content hash. */
  readonly cmap: Cmap;
  /** Built from `cmap` when absent. */
  readonly world?: CollisionWorld;
  /** Sent in HELLO; the server refuses another build. */
  readonly buildHash: string;
  /** Monotonic milliseconds: `performance.now` in the browser, a fake clock in tests. */
  readonly clock: () => number;
  /**
   * The client's registry: the mirror of the server's replicated cvars plus the client's own.
   * A new one with the pmove and client net cvars when absent.
   */
  readonly cvars?: CvarRegistry;
  /** Neutral input when absent. */
  readonly input?: CmdSampler;
  readonly nonce?: number;
  readonly log?: ClientLog;
}

function ignoreLog(): void {}

// Slots of ClientSim.t.
const LAST_FRAME = 0;
const ACC = 1;
const DT = 2;
const MISMATCH_SINCE = 3;

/**
 * The headless client (M2 design §1, §2): the connection, the clock, prediction and
 * reconciliation, the render offset and the stats, advanced once per render frame by `frame()`.
 * DOM-free, so the browser, the NET tests and the M3 bots all run this same code.
 *
 * A frame (M2 design §2, "Frame order"):
 * 1. Poll the transport: snapshots reconcile (`Predictor.onSnapshot`), CVARS switch parameters by
 *    tick, and any change to the predicted path is moved into the render offset so the drawn
 *    position stays where it was and then glides (snapped instead past `cl_teleportDist` or on a
 *    teleport).
 * 2. A clock step the snapshots asked for: fast-forward k ticks now, or hold k tick periods.
 * 3. The tick accumulator: per tick, sample a cmd, predict it and send INPUT with the last four
 *    cmds (at most MAX_TICKS_PER_FRAME ticks; the rest is owed to the next frames). A hard resync
 *    re-anchors once per poll, after the poll, from the newest snapshot.
 * 4. Pings and READY (the connection's handshake).
 *
 * The drawn position is `renderOrigin`: the predicted states of the last two ticks interpolated by
 * the accumulator's fraction (docs/05 §1.3), plus the render offset.
 */
export class ClientSim {
  /** [0] this frame's time (ms), shared with the clock, stats and render offset. */
  readonly now = new Float64Array(1);
  readonly cvars: CvarRegistry;
  readonly world: CollisionWorld;
  readonly settings = new ClientNetSettings();
  readonly clock: ClientClock;
  readonly stats: NetStats;
  readonly offset: RenderOffset;
  readonly predictor: Predictor;
  readonly connection: Connection;
  input: CmdSampler;
  /** The last tick of the startup fill: snapshots up to it may be starved without harm. */
  startTick = -1;
  frames = 0;
  /** Messages from PRINT, oldest first; the caller drains it (the console, a test). */
  readonly prints: string[] = [];

  private readonly cmap: Cmap;
  private readonly clockFn: () => number;
  private readonly log: ClientLog;
  /** [last frame time, tick accumulator, this frame's dt, cvar hash mismatch since]. */
  private readonly t = new Float64Array(4);
  private readonly cmd = new UserCmd();
  private readonly lastCmd = new UserCmd();
  private readonly fill = new UserCmd();
  private readonly before = vec3();
  private readonly after = vec3();
  private readonly delta = vec3();
  private readonly prevOrigin = vec3();
  private readonly curOrigin = vec3();
  /** The predicted path changed during this frame's poll. */
  private changed = false;
  /** A snapshot of this poll carried the teleport flag. */
  private teleport = false;
  /** Clock step asked for by this poll's snapshots (ticks; negative = hold). */
  private step = 0;
  /** The newest snapshot tick of this poll that needs a hard resync, −1 for none. */
  private resyncTick = -1;
  private started = false;

  constructor(options: ClientSimOptions) {
    this.cmap = options.cmap;
    this.world = options.world ?? buildCollisionWorld(options.cmap);
    let cvars = options.cvars;
    if (cvars === undefined) {
      cvars = new CvarRegistry();
      registerPmoveCvars(cvars);
      registerClientNetCvars(cvars);
    }
    this.cvars = cvars;
    refreshClientNetSettings(cvars, this.settings);
    this.clockFn = options.clock;
    this.log = options.log ?? ignoreLog;
    this.input = options.input ?? new NeutralInput();
    this.clock = new ClientClock(this.now);
    this.stats = new NetStats(this.now);
    this.offset = new RenderOffset(this.now);
    this.predictor = new Predictor(this.world);
    this.t[MISMATCH_SINCE] = Number.NaN;
    const handler: ConnectionHandler = {
      onWelcome: (m) => this.onWelcome(m),
      onSnapshot: (m) => this.onSnapshot(m),
      onCvars: (m) => this.onCvars(m),
      onPrint: (_level, text) => {
        this.prints.push(text);
      },
      onClosed: (reason) => this.log("info", `disconnected: ${reason}`),
    };
    this.connection = new Connection(
      options.transport,
      this.clock,
      this.stats,
      handler,
      options.buildHash,
      options.nonce ?? 0,
    );
  }

  /** Sends HELLO; frames then run the handshake. */
  connect(): void {
    this.now[0] = this.clockFn();
    this.connection.connect();
  }

  get state(): number {
    return this.connection.state;
  }

  get active(): boolean {
    return this.connection.state === CONN_ACTIVE;
  }

  /** The accumulator's fraction of a tick, 0..1: the interpolation weight of the newest tick. */
  get alpha(): number {
    return Math.min(1, Math.max(0, (this.t[ACC] as number) / TICK_MS));
  }

  /** One render frame (see the class comment). */
  frame(): void {
    const now = this.now;
    const t = this.t;
    now[0] = this.clockFn();
    t[DT] = this.started ? Math.max(0, (now[0] as number) - (t[LAST_FRAME] as number)) : 0;
    t[LAST_FRAME] = now[0] as number;
    this.started = true;
    this.frames++;
    refreshClientNetSettings(this.cvars, this.settings);
    this.stats.advance();
    const conn = this.connection;
    const wasActive = conn.state === CONN_ACTIVE;
    // The frame's time is owed before the poll, so a re-anchor in it (which sets the tick from
    // the snapshot, as of now) consumes it.
    if (wasActive) {
      t[ACC] = (t[ACC] as number) + (t[DT] as number);
      this.renderBase(this.before);
    }
    this.changed = false;
    this.teleport = false;
    this.step = 0;
    this.resyncTick = -1;
    conn.poll();
    if (conn.state === CONN_ACTIVE) {
      if (this.resyncTick >= 0) this.anchor(this.resyncTick, false);
      if (wasActive && this.changed) this.smoothChange();
      else if (!wasActive) this.offset.clear();
      if (this.step !== 0) this.takeStep(this.step);
      const p = this.predictor;
      let n = 0;
      while ((t[ACC] as number) >= TICK_MS && n < MAX_TICKS_PER_FRAME) {
        if (p.latestTick - p.snapshotTick > MAX_LEAD_TICKS) {
          // No snapshot for that long: hold the prediction instead of owing the time.
          t[ACC] = TICK_MS;
          break;
        }
        t[ACC] = (t[ACC] as number) - TICK_MS;
        this.tick();
        n++;
      }
      // A debt past the lead horizon is dropped; the snapshots then re-anchor (hard resync).
      if ((t[ACC] as number) > MAX_LEAD_TICKS * TICK_MS) t[ACC] = (t[ACC] as number) % TICK_MS;
    }
    conn.update();
  }

  /** The drawn position of the local player: interpolated prediction plus the render offset. */
  renderOrigin(out: Vec3): void {
    this.renderBase(out);
    const d = this.delta;
    this.offset.sample(d);
    out[0] = (out[0] as number) + (d[0] as number);
    out[1] = (out[1] as number) + (d[1] as number);
    out[2] = (out[2] as number) + (d[2] as number);
  }

  /** A console command for the server (CMD); false when there is no session or it doesn't fit. */
  sendCommand(text: string): boolean {
    return this.connection.sendCommand(text);
  }

  disconnect(reason = "disconnect"): void {
    this.connection.disconnect(reason);
  }

  // -------------------------------------------------------------------------------------------

  /** The predicted origin interpolated between the last two ticks, without the offset. */
  private renderBase(out: Vec3): void {
    const p = this.predictor;
    const latest = p.latestTick;
    if (latest < 0 || !p.originAt(latest, this.curOrigin)) {
      out.fill(0);
      return;
    }
    if (!p.originAt(latest - 1, this.prevOrigin)) this.prevOrigin.set(this.curOrigin);
    const a = Math.min(1, Math.max(0, (this.t[ACC] as number) / TICK_MS));
    const prev = this.prevOrigin;
    const cur = this.curOrigin;
    out[0] = (prev[0] as number) + ((cur[0] as number) - (prev[0] as number)) * a;
    out[1] = (prev[1] as number) + ((cur[1] as number) - (prev[1] as number)) * a;
    out[2] = (prev[2] as number) + ((cur[2] as number) - (prev[2] as number)) * a;
  }

  /**
   * The predicted path moved under the drawn position (`before`): carry the difference in the
   * render offset, or drop the offset for a teleport or a jump past `cl_teleportDist`.
   */
  private smoothChange(): void {
    const after = this.after;
    this.renderBase(after);
    const b = this.before;
    const d = this.delta;
    d[0] = (b[0] as number) - (after[0] as number);
    d[1] = (b[1] as number) - (after[1] as number);
    d[2] = (b[2] as number) - (after[2] as number);
    const dist = Math.sqrt(
      (d[0] as number) * (d[0] as number) +
        (d[1] as number) * (d[1] as number) +
        (d[2] as number) * (d[2] as number),
    );
    if (this.teleport || dist > this.settings.teleportDist) this.offset.clear();
    else this.offset.add(d, this.settings.correctionSmoothMs);
  }

  /** A clock step: fast-forward k ticks now (k > 0) or hold −k tick periods. */
  private takeStep(k: number): void {
    this.stats.add(STAT_CLOCK_ADJUSTMENTS, 1);
    this.renderBase(this.before);
    if (k > 0) {
      for (let i = 0; i < k; i++) this.tick();
    } else {
      this.t[ACC] = (this.t[ACC] as number) + k * TICK_MS;
    }
    this.teleport = false;
    this.smoothChange();
  }

  /** Samples, predicts and sends the next tick. */
  private tick(): void {
    const p = this.predictor;
    const cmd = this.cmd;
    const tick = p.latestTick + 1;
    cmd.tick = tick;
    this.input.sample(cmd, p.state);
    cmd.tick = tick;
    p.predict(cmd);
    copyUserCmd(this.lastCmd, cmd);
    this.connection.sendInput(p.cmds, tick, p.snapshotTick);
  }

  /**
   * Starts predicting from the server's state at `tick`, `lead` ticks ahead (M2 design §2): the
   * ticks up to there are filled with `fill`-style cmds, predicted and sent at once, and the
   * buffer-health watch restarts after them.
   */
  private anchor(tick: number, neutral: boolean): void {
    const p = this.predictor;
    const lead = Math.min(MAX_LEAD_TICKS, this.clock.leadTicks(this.settings.inputBuffer));
    const f = this.fill;
    if (neutral) {
      // Zero move at the spawn's angles: the server repeats this same neutral cmd until ours
      // arrive (D-027), so the startup costs no correction.
      f.buttons = 0;
      f.forward = 0;
      f.right = 0;
      f.up = 0;
      f.yaw = p.state.viewYaw;
      f.pitch = p.state.viewPitch;
      f.weaponSlot = 0;
    } else {
      copyUserCmd(f, this.lastCmd);
      f.buttons &= ~BUTTON_ATTACK;
    }
    const target = tick + lead;
    for (let t = tick + 1; t <= target; t++) {
      f.tick = t;
      p.predict(f);
      this.connection.sendInput(p.cmds, t, p.snapshotTick);
    }
    copyUserCmd(this.lastCmd, f);
    this.startTick = target;
    this.clock.anchor(target);
    this.t[ACC] = 0;
    // A step asked for by an earlier snapshot of this poll measured the old anchor.
    this.step = 0;
  }

  private onWelcome(m: WelcomeMsg): string | null {
    const cmap = this.cmap;
    const hi = Number.parseInt(cmap.contentHash.slice(0, 8), 16);
    const lo = Number.parseInt(cmap.contentHash.slice(8, 16), 16);
    if (m.mapName !== cmap.name || m.mapHashHi !== hi || m.mapHashLo !== lo) {
      return `server runs map ${m.mapName}, this client has ${cmap.name} (${cmap.contentHash})`;
    }
    const applied = applyCvarBlock(this.cvars, m.cvars);
    if (!applied.ok) return `server cvars refused (${applied.error} ${applied.name})`;
    this.predictor.setParams(this.cvars, cvarBlockHash(m.cvars));
    return null;
  }

  private onCvars(m: CvarsMsg): void {
    const applied = applyCvarBlock(this.cvars, m.block);
    if (!applied.ok) {
      this.connection.disconnect(`server cvars refused (${applied.error} ${applied.name})`);
      return;
    }
    this.predictor.setPendingParams(this.cvars, m.blockHash, m.effectiveTick);
    this.changed = true;
  }

  private onSnapshot(m: SnapshotMsg): void {
    const p = this.predictor;
    const stats = this.stats;
    stats.add(STAT_SNAPSHOTS, 1);
    if (this.connection.state === CONN_SPAWNING) {
      // The first snapshot is the spawn: adopted whole (it carries the teleport flag).
      p.reset(m.serverTick, m.state);
      this.anchor(m.serverTick, true);
      this.connection.markActive();
      return;
    }
    const prevTick = p.snapshotTick;
    const result = p.onSnapshot(m.serverTick, m.state, m.cvarHash);
    if (result === SNAPSHOT_STALE) return;
    if (m.serverTick > prevTick + 1) stats.add(STAT_SNAPSHOTS_LOST, m.serverTick - prevTick - 1);
    if ((m.flags & SNAP_FLAG_STARVED) !== 0 && m.serverTick > this.startTick) {
      stats.add(STAT_STARVED, 1);
    }
    if ((m.flags & SNAP_FLAG_TELEPORT) !== 0) this.teleport = true;
    const t = this.t;
    if (result === SNAPSHOT_PARAMS_RESYNC) {
      stats.add(STAT_PARAM_RESYNCS, 1);
      this.changed = true;
      // The block reached us late, or not at all: ask again after a while (docs/05 §3.5).
      if (Number.isNaN(t[MISMATCH_SINCE] as number)) t[MISMATCH_SINCE] = this.now[0] as number;
      else if ((this.now[0] as number) - (t[MISMATCH_SINCE] as number) >= CVAR_RESEND_AFTER_MS) {
        this.connection.sendCommand("cvars");
        t[MISMATCH_SINCE] = this.now[0] as number;
      }
    } else {
      t[MISMATCH_SINCE] = Number.NaN;
    }
    if (result === SNAPSHOT_CORRECTED) {
      const dist = p.lastCorrection;
      stats.add(STAT_CORRECTIONS, 1);
      stats.add(STAT_CORRECTION_DIST, dist[0] as number);
      stats.add(STAT_CORRECTION_MAX, dist[0] as number);
      this.changed = true;
    } else if (result === SNAPSHOT_HARD_RESYNC) {
      // A backlog after a stall resyncs on every snapshot ahead of the last; it is one event,
      // re-anchored once after the poll from the newest.
      if (this.resyncTick < 0) stats.add(STAT_HARD_RESYNCS, 1);
      this.resyncTick = m.serverTick;
      this.changed = true;
      return;
    }
    const step = this.clock.onSnapshotHealth(
      m.inputBufferHealth,
      m.serverTick,
      p.latestTick,
      this.settings.inputBuffer,
    );
    if (step !== 0) this.step = step;
  }

  /** Whether the session ended; `connection.closeReason` says why. */
  get closed(): boolean {
    return this.connection.state === CONN_CLOSED;
  }
}
