import {
  ClientSim,
  type CmdSampler,
  STAT_CLOCK_ADJUSTMENTS,
  STAT_CORRECTION_DIST,
  STAT_CORRECTION_MAX,
  STAT_CORRECTIONS,
  STAT_HARD_RESYNCS,
  STAT_PARAM_RESYNCS,
  STAT_SNAPSHOTS,
  STAT_STARVED,
} from "@game/client/net";
import { type LoopHost, Match, startMatchLoop } from "@game/server";
import {
  copyPlayerState,
  createLoopbackPair,
  Mulberry32,
  NET_PROFILE_LAN,
  type NetProfile,
  NetSimTransport,
  PlayerState,
  playerStateEquals,
  type Transport,
  vec3,
} from "@game/shared";
import { loadCourse } from "../../src/scenarios/course";

/**
 * The NET integration harness (M2 design §5, D-025): the real `Match` from @game/server and the
 * real client net code (`ClientSim`) over an in-memory loopback pair, optionally impaired by
 * `NetSimTransport` on the client's end, all on one fake clock. A tiny event loop runs the
 * server's own match loop (through a fake `LoopHost`), the simulator's wakes and client frames at
 * 144 Hz (or `frameHz`) ± 1 ms jitter, or as a frame model draws them (`frameIntervalMs`), in time
 * order, so a seed gives one run.
 *
 * It records the server's state of the player after every tick, the client's prediction of every
 * tick (the first one, and the one standing when the tick's snapshot was reconciled), and per frame
 * the drawn position, the player's speed and the render offset.
 */

export const HARNESS_BUILD = "net-harness";
export const FRAME_HZ = 144;

/** Draws the gap before the next client frame (ms) from the harness's seeded generator. */
export type FrameModel = (rng: Mulberry32) => number;

/** Steady 144 Hz ± 1 ms: the default. */
export const FRAMES_144HZ: FrameModel = (rng) => 1000 / FRAME_HZ + (rng.nextFloat() * 2 - 1);
/**
 * A browser at 60 fps ± 1 ms with hitches: 15% of the frames take 50–80 ms (layout, a slow
 * draw, a minor GC), so cmds leave in bursts of 3–5 ticks now and then.
 */
export const FRAMES_BROWSER_HITCHES: FrameModel = (rng) =>
  rng.nextFloat() < 0.15 ? 50 + rng.nextFloat() * 30 : 1000 / 60 + (rng.nextFloat() * 2 - 1);
/** A slow host: every frame 33–83 ms (12–30 fps), uniformly. */
export const FRAMES_SLOW_HOST: FrameModel = (rng) => 33 + rng.nextFloat() * 50;
/** A slower host: every frame 50–83 ms (12–20 fps), like SwiftShader in the e2e. */
export const FRAMES_SLOWER_HOST: FrameModel = (rng) => 50 + rng.nextFloat() * 33;
/**
 * `before` for the first `ms` of frames, then `after`: frames that turn bad mid-play. One per run
 * (it keeps the time it has drawn).
 */
export function framesSwitchingAt(ms: number, before: FrameModel, after: FrameModel): FrameModel {
  let elapsed = 0;
  return (rng) => {
    const gap = elapsed < ms ? before(rng) : after(rng);
    elapsed += gap;
    return gap;
  };
}

interface Timer {
  at: number;
  seq: number;
  cb: () => void;
}

export interface HarnessOptions {
  readonly input: CmdSampler;
  /** `lan` (the default) runs over the bare loopback pair, anything else through NetSim. */
  readonly profile?: NetProfile;
  readonly seed?: number;
  readonly map?: string;
  /** Client frame rate (FRAME_HZ by default); each frame still jitters by ±1 ms. */
  readonly frameHz?: number;
  /**
   * Draws each frame gap instead of `frameHz` (from the harness's generator, so a seed is one
   * run); FRAMES_144HZ by default.
   */
  readonly frameIntervalMs?: FrameModel;
  /** Wraps the client's transport (after NetSim), e.g. to drop or rewrite what it receives. */
  readonly wrap?: (t: Transport) => Transport;
}

/** Per-frame records for the smoothness checks. */
export class FrameLog {
  readonly time: number[] = [];
  /** The client's newest predicted tick. */
  readonly tick: number[] = [];
  readonly x: number[] = [];
  readonly y: number[] = [];
  readonly z: number[] = [];
  /** The faster of the two interpolated ticks' speeds, u/s. */
  readonly speed: number[] = [];
  /** Length of the render offset, u. */
  readonly offset: number[] = [];
  /** The clock's input buffer health: the mean and the low edge, ticks. */
  readonly buffer: number[] = [];
  readonly bufferLow: number[] = [];
  /** Since connecting: the clock steps taken (fast-forwards and holds) and the hard resyncs. */
  readonly clockSteps: number[] = [];
  readonly hardResyncs: number[] = [];
}

export class NetHarness {
  readonly match: Match;
  readonly client: ClientSim;
  readonly sim: NetSimTransport | null;
  readonly profile: NetProfile;
  /** The server's state of the player after each tick, by tick. */
  readonly server = new Map<number, PlayerState>();
  /** Server ticks that repeated a cmd because ours had not arrived. */
  readonly serverStarved: number[] = [];
  /** The client's first prediction of each tick. */
  readonly firstPredicted = new Map<number, PlayerState>();
  /** The prediction standing for each tick once the newest snapshot reached it. */
  readonly finalPredicted = new Map<number, PlayerState>();
  /** Each tick that was the client's newest snapshot after some frame (its reconcile point). */
  readonly snapshotTicks: number[] = [];
  readonly frames = new FrameLog();
  /** Every movement event the client filed (ClientSim.events), across frames, oldest first. */
  readonly events: { tick: number; type: number; value: number; jumped: boolean }[] = [];
  now = 0;
  /** Runs before every server tick (tests move the player or change the match here). */
  beforeServerTick: (() => void) | null = null;

  private readonly timers: Timer[] = [];
  private seq = 0;
  private readonly rng: Mulberry32;
  private readonly frameHz: number;
  private readonly frameModel: FrameModel;
  private lastFirst = -1;
  private lastFinal = -1;
  private readonly pos = vec3();
  private readonly off = vec3();
  private readonly a = new PlayerState();
  private readonly b = new PlayerState();
  private stopped = false;
  private starvedSeen = 0;
  /** No client frame runs before this time (a hitch: the next frame's dt spans it). */
  private pausedUntil = 0;

  constructor(options: HarnessOptions) {
    const course = loadCourse(options.map ?? "movement_lab");
    this.profile = options.profile ?? NET_PROFILE_LAN;
    this.frameHz = options.frameHz ?? FRAME_HZ;
    this.frameModel =
      options.frameIntervalMs ??
      (options.frameHz === undefined
        ? FRAMES_144HZ
        : (rng) => 1000 / this.frameHz + (rng.nextFloat() * 2 - 1));
    this.rng = new Mulberry32(((options.seed ?? 1) ^ 0x51f7) >>> 0);
    this.match = new Match({ cmap: course.cmap, world: course.world, buildHash: HARNESS_BUILD });
    const [clientEnd, serverEnd] = createLoopbackPair();
    this.match.connect(serverEnd, true);
    let transport: Transport = clientEnd;
    this.sim = null;
    if (this.profile.name !== NET_PROFILE_LAN.name) {
      const sim = new NetSimTransport(
        clientEnd,
        this.profile,
        () => this.now,
        options.seed ?? 1,
        (at) => this.schedule(at, () => sim.pump()),
      );
      this.sim = sim;
      transport = sim;
    }
    if (options.wrap !== undefined) transport = options.wrap(transport);
    this.client = new ClientSim({
      transport,
      cmap: course.cmap,
      world: course.world,
      buildHash: HARNESS_BUILD,
      clock: () => this.now,
      input: options.input,
    });
    const host: LoopHost = {
      now: () => this.now,
      schedule: (cb, ms) => this.schedule(this.now + ms, cb),
      log: () => {},
    };
    const match = this.match;
    startMatchLoop(
      {
        tick: () => {
          this.beforeServerTick?.();
          match.tick();
          this.recordServer();
        },
      },
      host,
    );
    this.client.connect();
    this.schedule(this.now + this.frameInterval(), () => this.frame());
  }

  /** Runs the event loop for `ms` of simulated time. */
  run(ms: number): void {
    const end = this.now + ms;
    while (!this.stopped) {
      const t = this.popBefore(end);
      if (t === null) break;
      this.now = t.at;
      t.cb();
    }
    this.now = end;
  }

  /** Runs until the client has predicted `ticks` ticks past its startup fill (or `maxMs` passed). */
  runTicks(ticks: number, maxMs = 120_000): void {
    const start = this.now;
    while (this.now - start < maxMs) {
      this.run(100);
      const c = this.client;
      if (c.active && c.predictor.latestTick - c.startTick >= ticks) return;
    }
    throw new Error(`no ${ticks} predicted ticks within ${maxMs} ms (state ${this.client.state})`);
  }

  stop(): void {
    this.stopped = true;
  }

  /** Stalls the client for `ms` from now (a GC, a tab switch): one frame then spans the gap. */
  hitch(ms: number): void {
    this.pausedUntil = this.now + ms;
  }

  /** Ticks where the server's state differs from `predictions` (both recorded). */
  mismatches(predictions: Map<number, PlayerState>, fromTick = 0): number[] {
    const out: number[] = [];
    for (const [tick, p] of predictions) {
      const s = this.server.get(tick);
      if (tick >= fromTick && s !== undefined && !playerStateEquals(s, p)) out.push(tick);
    }
    return out.sort((x, y) => x - y);
  }

  /**
   * Snapshot ticks the client reconciled with whose standing prediction still differs from the
   * server's state: empty whenever reconciliation works (the snapshot's state was matched or
   * adopted), whatever the link lost on the way.
   */
  unreconciled(): number[] {
    const out: number[] = [];
    for (const tick of this.snapshotTicks) {
      const s = this.server.get(tick);
      const p = this.finalPredicted.get(tick);
      if (s !== undefined && p !== undefined && !playerStateEquals(s, p)) out.push(tick);
    }
    return out;
  }

  /** How many ticks the client's newest prediction leads the server's newest tick. */
  lead(): number {
    return this.client.predictor.latestTick - this.match.serverTick;
  }

  /** Ticks with both a server state and a prediction in `predictions`. */
  compared(predictions: Map<number, PlayerState>): number {
    let n = 0;
    for (const tick of predictions.keys()) if (this.server.has(tick)) n++;
    return n;
  }

  totals(): {
    snapshots: number;
    corrections: number;
    meanCorrection: number;
    maxCorrection: number;
    starved: number;
    clockAdjustments: number;
    paramResyncs: number;
    hardResyncs: number;
  } {
    const t = this.client.stats.totals;
    const corrections = t[STAT_CORRECTIONS] as number;
    return {
      snapshots: t[STAT_SNAPSHOTS] as number,
      corrections,
      meanCorrection: corrections > 0 ? (t[STAT_CORRECTION_DIST] as number) / corrections : 0,
      maxCorrection: t[STAT_CORRECTION_MAX] as number,
      starved: t[STAT_STARVED] as number,
      clockAdjustments: t[STAT_CLOCK_ADJUSTMENTS] as number,
      paramResyncs: t[STAT_PARAM_RESYNCS] as number,
      hardResyncs: t[STAT_HARD_RESYNCS] as number,
    };
  }

  // -------------------------------------------------------------------------------------------

  private frameInterval(): number {
    return this.frameModel(this.rng);
  }

  private schedule(at: number, cb: () => void): void {
    this.timers.push({ at, seq: this.seq++, cb });
  }

  private popBefore(end: number): Timer | null {
    let best = -1;
    const timers = this.timers;
    for (let i = 0; i < timers.length; i++) {
      const t = timers[i] as Timer;
      const b = best < 0 ? null : (timers[best] as Timer);
      if (t.at <= end && (b === null || t.at < b.at || (t.at === b.at && t.seq < b.seq))) best = i;
    }
    if (best < 0) return null;
    const t = timers[best] as Timer;
    timers.splice(best, 1);
    return t;
  }

  private recordServer(): void {
    const s = this.match.session(0);
    if (s === undefined || s.spawnTick < 0) return;
    const tick = this.match.serverTick;
    this.server.set(tick, copyPlayerState(new PlayerState(), s.player));
    // A tick starves at most once, so the counter rising means this tick did.
    if (s.stats.starved > this.starvedSeen) {
      this.starvedSeen = s.stats.starved;
      this.serverStarved.push(tick);
    }
  }

  private frame(): void {
    if (this.now < this.pausedUntil) {
      this.schedule(this.pausedUntil, () => this.frame());
      return;
    }
    const c = this.client;
    c.frame();
    const ev = c.events;
    for (let i = 0; i < ev.count; i++) {
      this.events.push({
        tick: ev.ticks[i] as number,
        type: ev.types[i] as number,
        value: ev.values[i] as number,
        jumped: ev.jumped[i] === 1,
      });
    }
    if (c.active) {
      const p = c.predictor;
      for (let t = Math.max(this.lastFirst + 1, c.startTick - 200); t <= p.latestTick; t++) {
        if (p.stateAt(t, this.a))
          this.firstPredicted.set(t, copyPlayerState(new PlayerState(), this.a));
      }
      this.lastFirst = p.latestTick;
      for (let t = Math.max(this.lastFinal + 1, p.snapshotTick - 120); t <= p.snapshotTick; t++) {
        if (p.stateAt(t, this.a))
          this.finalPredicted.set(t, copyPlayerState(new PlayerState(), this.a));
      }
      if (p.snapshotTick > this.lastFinal) this.snapshotTicks.push(p.snapshotTick);
      this.lastFinal = Math.max(this.lastFinal, p.snapshotTick);
      this.recordFrame();
    }
    this.schedule(this.now + this.frameInterval(), () => this.frame());
  }

  private recordFrame(): void {
    const c = this.client;
    const p = c.predictor;
    const f = this.frames;
    c.renderOrigin(this.pos);
    c.offset.sample(this.off);
    let speed = 0;
    if (p.stateAt(p.latestTick, this.a)) speed = speedOf(this.a);
    if (p.stateAt(p.latestTick - 1, this.b)) speed = Math.max(speed, speedOf(this.b));
    f.time.push(this.now);
    f.tick.push(p.latestTick);
    f.x.push(this.pos[0] as number);
    f.y.push(this.pos[1] as number);
    f.z.push(this.pos[2] as number);
    f.speed.push(speed);
    f.offset.push(Math.hypot(this.off[0] as number, this.off[1] as number, this.off[2] as number));
    f.buffer.push(c.clock.bufferHealth);
    f.bufferLow.push(c.clock.bufferLow);
    f.clockSteps.push(c.stats.totals[STAT_CLOCK_ADJUSTMENTS] as number);
    f.hardResyncs.push(c.stats.totals[STAT_HARD_RESYNCS] as number);
  }
}

function speedOf(ps: PlayerState): number {
  const v = ps.velocity;
  return Math.hypot(v[0] as number, v[1] as number, v[2] as number);
}
