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
import {
  type LoopHost,
  MATCH_MAX_CLIENTS,
  Match,
  type MatchLog,
  type MatchLoop,
  type Session,
  startMatchLoop,
  TickWindow,
} from "@game/server";
import {
  type Cmap,
  type CollisionWorld,
  copyPlayerState,
  createLoopbackPair,
  frameDigest,
  type LoopbackEndpoint,
  Mulberry32,
  NET_PROFILE_LAN,
  type NetProfile,
  NetSimTransport,
  PlayerState,
  playerStateEquals,
  SNAPSHOT_HISTORY,
  type Transport,
  type TransportStats,
  vec3,
} from "@game/shared";
import { loadCourse } from "../../src/scenarios/course";

/**
 * The multi-client NET harness (M3 design §1 tools, §5 "Harness"): the real `Match` from
 * @game/server with its own match loop, and up to 64 clients on one fake clock. Each client is
 * the real client net code (`ClientSim`) over an in-memory loopback pair, impaired by its own
 * `NetSimTransport` (its own profile and seed) unless its profile is `lan`, with frames drawn from
 * its own seeded frame model. Raw endpoints stand in for attackers: bytes in, bytes out, no client
 * code. Every server session's traffic is counted by message type (`SessionTap`).
 *
 * Timers sit in a binary heap ordered by (time, scheduling order), so a seed gives one run, and a
 * one-client harness runs exactly as the M2 harness did (`harness.ts` is now a facade over this).
 *
 * Clients that `record` keep what the M2 harness kept: the server's state of their player after
 * every tick, their first and final predictions of every tick, the ticks they reconciled with, a
 * per-frame log and their movement events. They also check every frame their snapshot store takes
 * against the frame the server encoded it from (`frameDigest`, as that client sees it; M3 design
 * §5 "Harness"). The others keep only their counters, so 64 clients stay cheap.
 */

export const HARNESS_BUILD = "net-harness";
export const FRAME_HZ = 144;
/**
 * Player slots of a match: the most clients a harness could hold. The match admits its
 * `maxClients` (`sv_maxClients`: 32 by default, at most 37 until the D-046 scheduler, D-034), and
 * `addClient` refuses one it has no free slot for.
 */
export const MAX_HARNESS_CLIENTS = MATCH_MAX_CLIENTS;

/** Draws the gap before the next client frame (ms) from the client's seeded generator. */
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
 * `before` for the first `ms` of frames, then `after`: frames that turn bad mid-play. One per
 * client (it keeps the time it has drawn).
 */
export function framesSwitchingAt(ms: number, before: FrameModel, after: FrameModel): FrameModel {
  let elapsed = 0;
  return (rng) => {
    const gap = elapsed < ms ? before(rng) : after(rng);
    elapsed += gap;
    return gap;
  };
}

/**
 * The default NetSim and frame seed of the client that joins `index`-th (from 0) in a harness
 * seeded `seed`: the first client gets the harness seed itself, so a one-client run is the M2
 * harness's run.
 */
export function clientSeed(seed: number, index: number): number {
  return (seed + index * 7919) >>> 0;
}

/** Per-frame records for the smoothness checks (recording clients only). */
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

/** Message and byte counts of one direction of a session, in total and by message type. */
export class TrafficCounts {
  messages = 0;
  bytes = 0;
  /** By the leading type byte (0–255): messages, bytes and the largest message. */
  readonly messagesByType = new Float64Array(256);
  readonly bytesByType = new Float64Array(256);
  readonly maxByType = new Float64Array(256);

  count(d: Uint8Array, len: number): void {
    const type = len > 0 ? (d[0] as number) : 0;
    this.messages++;
    this.bytes += len;
    this.messagesByType[type] = (this.messagesByType[type] as number) + 1;
    this.bytesByType[type] = (this.bytesByType[type] as number) + len;
    this.maxByType[type] = Math.max(this.maxByType[type] as number, len);
  }
}

/**
 * The server's end of a session, counting what the match sends (`down`, before any loss on the
 * way) and what reaches it (`up`): the per-session bytes of NET-08 (payload only; WebSocket framing
 * is added by the test that judges bandwidth, D-036).
 */
export class SessionTap implements Transport {
  readonly down = new TrafficCounts();
  readonly up = new TrafficCounts();

  /**
   * `held()` true keeps what arrived from the match's poll (the harness holds a stalled server's
   * input, `MultiHarness.stallServer`).
   */
  constructor(
    readonly inner: Transport,
    private readonly held: () => boolean = () => false,
  ) {}

  // Counted only when the inner transport took the message (its own `sent` rose).
  sendUnreliable(d: Uint8Array, len: number): void {
    const sent = this.inner.stats().sent;
    this.inner.sendUnreliable(d, len);
    if (this.inner.stats().sent > sent) this.down.count(d, len);
  }

  sendReliable(d: Uint8Array, len: number): void {
    const sent = this.inner.stats().sent;
    this.inner.sendReliable(d, len);
    if (this.inner.stats().sent > sent) this.down.count(d, len);
  }

  onMessage(cb: (d: Uint8Array, len: number, reliable: boolean) => void): void {
    this.inner.onMessage((d, len, reliable) => {
      this.up.count(d, len);
      cb(d, len, reliable);
    });
  }

  onClose(cb: (reason: string) => void): void {
    this.inner.onClose(cb);
  }

  poll(): void {
    if (!this.held()) this.inner.poll();
  }

  close(reason?: string): void {
    this.inner.close(reason);
  }

  isOpen(): boolean {
    return this.inner.isOpen();
  }

  stats(): TransportStats {
    return this.inner.stats();
  }
}

export interface MultiHarnessOptions {
  /** The course the match and every client load (`movement_lab` by default). */
  readonly map?: string;
  /** Base seed: client k's NetSim and frames default to `clientSeed(seed, k)`. Default 1. */
  readonly seed?: number;
  /** Times every `match.tick()` on the real clock into `tickTimes` (µs). */
  readonly timeTicks?: boolean;
  /** The match's log (ignored by default). */
  readonly log?: MatchLog;
  /** `sv_maxClients` for the match (its default, 32, when absent). */
  readonly maxClients?: number;
}

export interface ClientOptions {
  readonly input: CmdSampler;
  /** `lan` (the default) runs over the bare loopback pair, anything else through NetSim. */
  readonly profile?: NetProfile;
  /** NetSim and frame seed; `clientSeed(harness seed, join index)` by default. */
  readonly seed?: number;
  /** Client frame rate (FRAME_HZ by default); each frame still jitters by ±1 ms. */
  readonly frameHz?: number;
  /** Draws each frame gap instead of `frameHz` (from the client's own generator). */
  readonly frameIntervalMs?: FrameModel;
  /** Wraps the client's transport (after NetSim), e.g. to drop or rewrite what it receives. */
  readonly wrap?: (t: Transport) => Transport;
  /** May change replicated cvars (the Worker's one client is admin). Default false. */
  readonly admin?: boolean;
  /** Keeps per-tick states, predictions and a frame log (see `HarnessClient`). Default false. */
  readonly record?: boolean;
}

interface TimerHeap {
  at: number[];
  seq: number[];
  cb: (() => void)[];
}

/** One `ClientSim` in the harness, with its link, its server session and its records. */
export class HarnessClient {
  readonly client: ClientSim;
  readonly sim: NetSimTransport | null;
  readonly profile: NetProfile;
  /** The server's session, null when the match was full (the client was KICKed). */
  readonly session: Session | null;
  /** The server end of the session, counting its traffic. */
  readonly tap: SessionTap;
  /** When it joined (harness ms). */
  readonly joinedAt: number;
  readonly record: boolean;
  /** The server's state of the player after each tick, by tick (recording clients). */
  readonly server = new Map<number, PlayerState>();
  /** Server ticks that repeated a cmd because this client's had not arrived. */
  readonly serverStarved: number[] = [];
  /** The client's first prediction of each tick (recording clients). */
  readonly firstPredicted = new Map<number, PlayerState>();
  /** The prediction standing for each tick once the newest snapshot reached it. */
  readonly finalPredicted = new Map<number, PlayerState>();
  /** Each tick that was the client's newest snapshot after some frame (its reconcile point). */
  readonly snapshotTicks: number[] = [];
  readonly frames = new FrameLog();
  /** Every movement event the client filed (ClientSim.events), across frames, oldest first. */
  readonly events: { tick: number; type: number; value: number; jumped: boolean }[] = [];
  /** `frameDigest` of the server's world frame after each tick, as this client sees it. */
  readonly serverDigests = new Map<number, number>();
  /** Stored frames checked against `serverDigests`, and the ticks whose frame differed. */
  digestsChecked = 0;
  readonly digestMismatches: number[] = [];
  /** The tick of each store ring slot when it was last checked. */
  private readonly checkedTicks = new Int32Array(SNAPSHOT_HISTORY);
  /** It called `leave`; its frames stop then (and once its session closed for any reason). */
  left = false;

  private readonly rng: Mulberry32;
  private readonly frameModel: FrameModel;
  private lastFirst = -1;
  private lastFinal = -1;
  private readonly pos = vec3();
  private readonly off = vec3();
  private readonly a = new PlayerState();
  private readonly b = new PlayerState();
  private starvedSeen = 0;
  /** No client frame runs before this time (a hitch: the next frame's dt spans it). */
  private pausedUntil = 0;

  constructor(
    private readonly harness: MultiHarness,
    readonly index: number,
    options: ClientOptions,
    course: { readonly cmap: Cmap; readonly world: CollisionWorld },
  ) {
    const h = harness;
    const seed = options.seed ?? clientSeed(h.seed, index);
    this.record = options.record ?? false;
    this.joinedAt = h.now;
    this.profile = options.profile ?? NET_PROFILE_LAN;
    const frameHz = options.frameHz ?? FRAME_HZ;
    this.frameModel =
      options.frameIntervalMs ??
      (options.frameHz === undefined
        ? FRAMES_144HZ
        : (rng) => 1000 / frameHz + (rng.nextFloat() * 2 - 1));
    this.rng = new Mulberry32((seed ^ 0x51f7) >>> 0);
    const [clientEnd, serverEnd] = createLoopbackPair();
    this.tap = new SessionTap(serverEnd, () => h.serverInputHeld);
    this.session = h.match.connect(this.tap, options.admin ?? false);
    let transport: Transport = clientEnd;
    this.sim = null;
    if (this.profile.name !== NET_PROFILE_LAN.name) {
      const sim = new NetSimTransport(
        clientEnd,
        this.profile,
        () => h.now,
        seed,
        (at) => h.at(at, () => sim.pump()),
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
      clock: () => h.now,
      input: options.input,
    });
    this.client.connect();
    h.at(h.now + this.frameInterval(), () => this.frame());
  }

  /** Stalls the client for `ms` from now (a GC, a tab switch): one frame then spans the gap. */
  hitch(ms: number): void {
    this.pausedUntil = this.harness.now + ms;
  }

  /** Disconnects (the server sees the close after the link's delay) and stops its frames. */
  leave(reason = "disconnect"): void {
    this.client.disconnect(reason);
    this.left = true;
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
    return this.client.predictor.latestTick - this.harness.match.serverTick;
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

  /** @internal After every server tick: the server's state and starved repeats of this player. */
  afterServerTick(): void {
    const s = this.session;
    // Still in the match (a closed session leaves it at the next tick's poll) and spawned.
    if (s === null || this.harness.match.session(s.clientId) !== s || s.spawnTick < 0) return;
    const tick = this.harness.match.serverTick;
    if (this.record) {
      this.server.set(tick, copyPlayerState(new PlayerState(), s.player));
      this.serverDigests.set(tick, frameDigest(this.harness.match.worldFrame, s.clientId));
    }
    // A tick starves at most once, so the counter rising means this tick did.
    if (s.stats.starved > this.starvedSeen) {
      this.starvedSeen = s.stats.starved;
      this.serverStarved.push(tick);
    }
  }

  private frameInterval(): number {
    return this.frameModel(this.rng);
  }

  private frame(): void {
    // A closed session (left, KICKed, refused) has nothing more to draw or send.
    if (this.left || this.client.closed) return;
    const h = this.harness;
    if (h.now < this.pausedUntil) {
      h.at(this.pausedUntil, () => this.frame());
      return;
    }
    const c = this.client;
    c.frame();
    if (this.record) this.recordAfterFrame();
    h.at(h.now + this.frameInterval(), () => this.frame());
  }

  /** Checks the frames the client's store took since the last frame against the server's. */
  private checkStoredFrames(): void {
    const ring = this.client.store.ring;
    const self = this.client.connection.clientId;
    for (let i = 0; i < SNAPSHOT_HISTORY; i++) {
      const tick = ring.tickAt(i);
      if (tick === 0 || tick === this.checkedTicks[i]) continue;
      this.checkedTicks[i] = tick;
      const frame = ring.get(tick);
      const want = this.serverDigests.get(tick);
      if (frame === null || want === undefined) continue;
      this.digestsChecked++;
      if (frameDigest(frame, self) !== want) this.digestMismatches.push(tick);
    }
  }

  private recordAfterFrame(): void {
    const c = this.client;
    this.checkStoredFrames();
    const ev = c.events;
    for (let i = 0; i < ev.count; i++) {
      this.events.push({
        tick: ev.ticks[i] as number,
        type: ev.types[i] as number,
        value: ev.values[i] as number,
        jumped: ev.jumped[i] === 1,
      });
    }
    if (!c.active) return;
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

  private recordFrame(): void {
    const c = this.client;
    const p = c.predictor;
    const f = this.frames;
    c.renderOrigin(this.pos);
    c.offset.sample(this.off);
    let speed = 0;
    if (p.stateAt(p.latestTick, this.a)) speed = speedOf(this.a);
    if (p.stateAt(p.latestTick - 1, this.b)) speed = Math.max(speed, speedOf(this.b));
    f.time.push(this.harness.now);
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

/** A message a raw endpoint received: its type byte, channel and a copy of its bytes. */
export interface RawMessage {
  readonly type: number;
  readonly reliable: boolean;
  readonly bytes: Uint8Array;
}

/**
 * A raw endpoint (an attacker, or a client the test speaks for byte by byte): a loopback end
 * connected to the match with no client code behind it. The harness polls it after every server
 * tick, so `received` and `closedReason` follow the server.
 */
export class RawClient {
  /** The server's session, null when the match was full. */
  readonly session: Session | null;
  readonly tap: SessionTap;
  readonly received: RawMessage[] = [];
  /** The close the server sent (its reason), null while open. */
  closedReason: string | null = null;

  constructor(
    match: Match,
    readonly transport: LoopbackEndpoint,
    serverEnd: LoopbackEndpoint,
    admin: boolean,
  ) {
    this.tap = new SessionTap(serverEnd);
    this.session = match.connect(this.tap, admin);
    transport.onMessage((d, len, reliable) => {
      this.received.push({
        type: len > 0 ? (d[0] as number) : -1,
        reliable,
        bytes: d.slice(0, len),
      });
    });
    transport.onClose((reason) => {
      this.closedReason = reason;
    });
  }

  send(bytes: Uint8Array, reliable: boolean, len = bytes.length): void {
    if (reliable) this.transport.sendReliable(bytes, len);
    else this.transport.sendUnreliable(bytes, len);
  }

  /** The messages received of `type`. */
  ofType(type: number): RawMessage[] {
    return this.received.filter((m) => m.type === type);
  }
}

export class MultiHarness {
  readonly match: Match;
  readonly loop: MatchLoop;
  readonly seed: number;
  readonly mapName: string;
  /** Every client added, in join order (left ones included). */
  readonly clients: HarnessClient[] = [];
  readonly raws: RawClient[] = [];
  /** `match.tick()` times on the real clock, µs (`timeTicks`), else null. */
  readonly tickTimes: TickWindow | null;
  now = 0;
  /** Runs before every server tick (tests move players or change the match here). */
  beforeServerTick: (() => void) | null = null;
  /** Runs after every server tick, once the clients' records are taken. */
  afterServerTick: (() => void) | null = null;

  private readonly course: { readonly cmap: Cmap; readonly world: CollisionWorld };
  private readonly timers: TimerHeap = { at: [], seq: [], cb: [] };
  private seq = 0;
  private stopped = false;
  /** The server's host is stalled until this harness time (`stallServer`). */
  private serverStalledUntil = 0;
  /** The release of a stall's held input is queued. */
  private releaseQueued = false;
  private inputHeld = false;

  constructor(options: MultiHarnessOptions = {}) {
    this.mapName = options.map ?? "movement_lab";
    this.course = loadCourse(this.mapName);
    this.seed = options.seed ?? 1;
    this.tickTimes = options.timeTicks === true ? new TickWindow() : null;
    this.match = new Match({
      cmap: this.course.cmap,
      world: this.course.world,
      buildHash: HARNESS_BUILD,
      log: options.log,
      ...(options.maxClients === undefined ? {} : { maxClients: options.maxClients }),
    });
    const host: LoopHost = {
      now: () => this.now,
      schedule: (cb, ms) => this.at(this.now + ms, () => this.serverWake(cb)),
      log: () => {},
    };
    this.loop = startMatchLoop({ tick: () => this.serverTick() }, host);
  }

  /** Clients still playing: not `left`, and their session not closed (a KICK closes it). */
  get active(): HarnessClient[] {
    return this.clients.filter((c) => !c.left && !c.client.closed);
  }

  /**
   * Adds a client now: it connects at once and its first frame comes one frame gap later. Refused
   * while the match holds its `maxClients` sessions, clients and raw endpoints alike, as the match
   * counts them: a session that left stays until its close has crossed the link and a tick polled
   * it, so a rejoin into its slot waits for `match.session(id) === undefined` first.
   */
  addClient(options: ClientOptions): HarnessClient {
    const cap = this.match.maxClients;
    if (this.match.sessionCount >= cap) throw new Error(`a match holds ${cap} clients`);
    const c = new HarnessClient(this, this.clients.length, options, this.course);
    this.clients.push(c);
    return c;
  }

  /**
   * Adds a raw endpoint now (no HELLO is sent: the test sends what it wants). Not capped here: past
   * the match's `maxClients` it gets the match's own "server full" KICK and a null session.
   */
  addRaw(admin = false): RawClient {
    const [clientEnd, serverEnd] = createLoopbackPair();
    const r = new RawClient(this.match, clientEnd, serverEnd, admin);
    this.raws.push(r);
    return r;
  }

  /**
   * Stalls the server's host for `ms` from now (its JS blocked: a GC, a long callback): its loop's
   * wakes wait for the end, while the clients' frames go on. The input that arrives meanwhile is
   * read only after the wake that is due at the end, the order Node keeps for such a stall (an
   * overdue timer runs before the socket reads that piled up; D-027). That order is an assumption
   * here: `packages/tools/long/server-stall.long.ts` checks it on the real Node server. The match
   * loop's yield on a late wake is what lets that input reach the catch-up ticks. Raw endpoints
   * are not held.
   */
  stallServer(ms: number): void {
    this.serverStalledUntil = Math.max(this.serverStalledUntil, this.now + ms);
    this.inputHeld = true;
  }

  /**
   * The clients' input is held from the match while a stall's I/O waits (`stallServer`): the
   * match's polls of their sessions deliver nothing.
   */
  get serverInputHeld(): boolean {
    return this.inputHeld;
  }

  /** Runs `cb` at harness time `atMs` (now if it is past), after timers already due then. */
  at(atMs: number, cb: () => void): void {
    const h = this.timers;
    let i = h.at.length;
    // A past time runs now: the clock feeds the match's LoopHost, which never steps back.
    h.at.push(Math.max(atMs, this.now));
    h.seq.push(this.seq++);
    h.cb.push(cb);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  /** Runs the event loop for `ms` of simulated time. */
  run(ms: number): void {
    const end = this.now + ms;
    const h = this.timers;
    while (!this.stopped && h.at.length > 0 && (h.at[0] as number) <= end) {
      const at = h.at[0] as number;
      const cb = this.popFront();
      this.now = at;
      cb();
    }
    this.now = end;
  }

  /** Runs in 100 ms steps until `done()` holds; throws after `maxMs` with `what` in the message. */
  runUntil(done: () => boolean, maxMs: number, what: string): void {
    const start = this.now;
    while (this.now - start < maxMs) {
      this.run(100);
      if (done()) return;
    }
    throw new Error(`no ${what} within ${maxMs} ms`);
  }

  /** Stops the event loop: `run` returns at once from now on. */
  stop(): void {
    this.stopped = true;
  }

  /** A wake of the match loop: during a stall it moves to the stall's end, ahead of the I/O. */
  private serverWake(cb: () => void): void {
    const until = this.serverStalledUntil;
    if (this.now < until) {
      this.at(until, () => this.serverWake(cb));
      if (!this.releaseQueued) {
        // Queued after the wake, at the same time: the timer first, then the reads.
        this.releaseQueued = true;
        this.at(until, () => {
          this.releaseQueued = false;
          this.inputHeld = false;
        });
      }
      return;
    }
    // A stall that ended before the loop's next wake was due made no wake late: nothing to order.
    if (this.inputHeld && !this.releaseQueued) this.inputHeld = false;
    cb();
  }

  private serverTick(): void {
    this.beforeServerTick?.();
    const times = this.tickTimes;
    if (times === null) {
      this.match.tick();
    } else {
      const t0 = performance.now();
      this.match.tick();
      times.record((performance.now() - t0) * 1000);
    }
    const clients = this.clients;
    for (let i = 0; i < clients.length; i++) (clients[i] as HarnessClient).afterServerTick();
    const raws = this.raws;
    for (let i = 0; i < raws.length; i++) (raws[i] as RawClient).transport.poll();
    this.afterServerTick?.();
  }

  private before(i: number, j: number): boolean {
    const h = this.timers;
    const ai = h.at[i] as number;
    const aj = h.at[j] as number;
    return ai < aj || (ai === aj && (h.seq[i] as number) < (h.seq[j] as number));
  }

  private swap(i: number, j: number): void {
    const h = this.timers;
    const at = h.at[i] as number;
    h.at[i] = h.at[j] as number;
    h.at[j] = at;
    const seq = h.seq[i] as number;
    h.seq[i] = h.seq[j] as number;
    h.seq[j] = seq;
    const cb = h.cb[i] as () => void;
    h.cb[i] = h.cb[j] as () => void;
    h.cb[j] = cb;
  }

  private popFront(): () => void {
    const h = this.timers;
    const cb = h.cb[0] as () => void;
    const last = h.at.length - 1;
    this.swap(0, last);
    h.at.pop();
    h.seq.pop();
    h.cb.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < last && this.before(l, m)) m = l;
      if (r < last && this.before(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return cb;
  }
}

function speedOf(ps: PlayerState): number {
  const v = ps.velocity;
  return Math.hypot(v[0] as number, v[1] as number, v[2] as number);
}
