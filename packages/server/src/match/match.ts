import {
  BitReader,
  BitWriter,
  BUTTON_ATTACK,
  buildCollisionWorld,
  type Cmap,
  CmdMsg,
  type CollisionWorld,
  CvarBlock,
  CvarRegistry,
  CvarsMsg,
  captureCvarBlock,
  copyUserCmd,
  cvarHash16,
  DEV_ASSERT,
  decodeCmd,
  decodeHello,
  decodeInput,
  decodePing,
  decodeReady,
  ENTITY_EVENT_SLOTS,
  ENTITY_NONE,
  encodeCvars,
  encodeKick,
  encodePong,
  encodePrint,
  encodeSnapshot,
  encodeWelcome,
  entityEventValue,
  groundTrace,
  HelloMsg,
  HULL_MINS,
  HULL_STANDING_MAXS,
  InputMsg,
  KickMsg,
  MATCH_MAX_CLIENTS,
  MAX_RELIABLE_BYTES,
  MSG_CMD,
  MSG_HELLO,
  MSG_INPUT,
  MSG_PING,
  MSG_READY,
  PingMsg,
  type PlayerState,
  PmoveEvent,
  PmoveEvents,
  PmoveParams,
  PongMsg,
  PRINT_WARN,
  PROTOCOL_VERSION,
  PrintMsg,
  peekHelloVersion,
  peekMessageType,
  playerStateToSlot,
  pmove,
  pushEntityEvent,
  quantizePlayerState,
  refreshPmoveParams,
  registerPmoveCvars,
  registryCvarHash,
  SNAP_FIT_MAX_PLAYERS,
  SNAP_FLAG_STARVED,
  SnapshotHeader,
  sanitizeUserCmd,
  TEAM_1,
  TEAM_2,
  TICK_DT,
  TICK_MAX,
  TICK_RATE,
  type Transport,
  UserCmd,
  WelcomeMsg,
  WorldFrame,
} from "@game/shared";
import { runServerCommand } from "./commands";
import type { MatchLog } from "./host";
import {
  SESSION_ACTIVE,
  SESSION_CLOSED,
  SESSION_CONNECTING,
  SESSION_WELCOMED,
  Session,
} from "./session";
import { assignTeam, SpawnRotation } from "./spawns";

/** Player slots (D-034), from @game/shared since protocol v2 put them on the wire. */
export { MATCH_MAX_CLIENTS };

/** Players a match admits by default (`sv_maxClients`; D-034, design: "Cap 64, default 32"). */
export const MATCH_DEFAULT_MAX_CLIENTS = 32;

/**
 * The cap a match applies for `sv_maxClients` = `requested`: at least 1, and at most
 * SNAP_FIT_MAX_PLAYERS (37) until the D-046 byte-budget scheduler, so every snapshot fits 1100 B by
 * construction (D-034). A non-finite request (NaN would pass Math.min/max) takes the default.
 */
export function effectiveMaxClients(requested: number): number {
  const n = Number.isFinite(requested) ? Math.floor(requested) : MATCH_DEFAULT_MAX_CLIENTS;
  return Math.max(1, Math.min(SNAP_FIT_MAX_PLAYERS, MATCH_MAX_CLIENTS, n));
}

/** Stamina at spawn, in hundredths: staminaMax = health 100 with no vest (docs/03 §5.2, FACT). */
export const SPAWN_STAMINA = 100 * 100;

export interface MatchOptions {
  readonly cmap: Cmap;
  /** Built from `cmap` when absent. */
  readonly world?: CollisionWorld;
  /** The server's registry; a new one with the pmove cvars when absent. */
  readonly cvars?: CvarRegistry;
  /** HELLO's buildHash must equal it (short ASCII), unless `strictBuild` is false. */
  readonly buildHash: string;
  /**
   * Whether a client of another build is KICKed (default true; `sv_strictBuild`, D-031). When
   * false it gets its WELCOME and a PRINT warning naming both builds. The protocol version is
   * always strict.
   */
  readonly strictBuild?: boolean;
  /**
   * `sv_maxClients`: players admitted (MATCH_DEFAULT_MAX_CLIENTS when absent), clamped by
   * `effectiveMaxClients`. Client ids are the lowest free below it; a client past it is KICKed
   * "server full".
   */
  readonly maxClients?: number;
  readonly log?: MatchLog;
}

/** Match-wide counters (live). */
export class MatchMetrics {
  ticks = 0;
  /** Starved player-ticks, all clients. */
  starved = 0;
  /** Strikes, all clients. */
  strikes = 0;
  snapshots = 0;
  kicks = 0;
  /** CVARS messages sent (broadcasts and resends). */
  cvarsSent = 0;
}

function ignoreLog(): void {}

/** Lowest free client id below `cap`, or −1 when every one is taken. `sessions` is sorted by id. */
function freeClientId(sessions: readonly Session[], cap: number): number {
  let id = 0;
  for (let i = 0; i < sessions.length; i++) {
    if ((sessions[i] as Session).clientId !== id) break;
    id++;
  }
  return id < cap ? id : -1;
}

/**
 * One match (docs/05 §8.1, M2 design §2, D-027): its world, the server's cvars and every client
 * session, advanced one tick per `tick()`. Environment-agnostic: no clock, timer or I/O of its
 * own (the loop and the transports bring them), so the same code runs in the Worker and in Node.
 *
 * `tick()` simulates T = serverTick + 1, in this order:
 * 1. Poll every session's transport in client-id order and handle what arrived: HELLO (version
 *    and build checked, else KICK; then WELCOME), READY (a team, then a spawn at the next point
 *    of the rotation), INPUT (into the input queue), PING (PONG), CMD (console commands; changing
 *    cvars needs the admin flag).
 * 2. If the cvars changed: refresh the pmove params and, when the replicated block changed,
 *    broadcast CVARS with effectiveTick = T, the first tick simulated with the new values.
 * 3. Per active client in id order: take its cmd for T, or repeat its last cmd with ATTACK cleared
 *    and tick = T (starved); sanitize; pmove, whose movement events join the slot's event history
 *    (the count and the two newest, as entities carry them). A player spawned this tick is not
 *    simulated: its spawn state is its state at T.
 * 4. Capture the world frame of T: every active player's state, serial, team, teleport counter
 *    and event history.
 * 5. Per active client: a full SNAPSHOT of T (protocol v2, D-033): its own state as the local block,
 *    every other active player as an entity record, inputBufferHealth = newest cmd tick received −
 *    T (clamped to i8), flagged STARVED.
 * 6. Metrics.
 *
 * After warm-up a tick allocates nothing: messages decode into and encode from preallocated
 * structs, and the transports pool their packets. HELLO, CMD, kicks and cvar changes allocate
 * (rare reliable traffic).
 */
export class Match {
  readonly world: CollisionWorld;
  readonly cvars: CvarRegistry;
  readonly params = new PmoveParams();
  readonly metrics = new MatchMetrics();
  readonly mapName: string;
  readonly mapHashLo: number;
  readonly mapHashHi: number;
  readonly buildHash: string;
  readonly strictBuild: boolean;
  /** The map's `info_player_start` points, taken round-robin by every spawn (D-034). */
  readonly spawns: SpawnRotation;
  /** Players admitted: `sv_maxClients` after `effectiveMaxClients`. */
  readonly maxClients: number;
  /** Every active player at the last tick simulated, as snapshots are encoded from it (D-034). */
  readonly worldFrame = new WorldFrame();

  private readonly log: MatchLog;
  private readonly sessions: Session[] = [];
  private currentTick = 0;
  private anyClosed = false;

  /** The replicated block simulated now, its u32 hash and the tick it took effect. */
  private readonly block = new CvarBlock();
  private blockHash = 0;
  private blockHash16 = 0;
  private blockEffectiveTick = 0;
  private cvarVersion = -1;

  private readonly writer = new BitWriter(MAX_RELIABLE_BYTES);
  private readonly reader = new BitReader();
  private readonly hello = new HelloMsg();
  private readonly welcome = new WelcomeMsg();
  private readonly input = new InputMsg();
  private readonly snapHeader = new SnapshotHeader();
  /**
   * Per slot: the teleport counter every spawn bumps (8 bits, kept across the slot's players, so a
   * new player in a slot snaps on every client; D-035) and the connect counter (`Session.serial`).
   */
  private readonly teleportSeqs = new Uint8Array(MATCH_MAX_CLIENTS);
  private readonly serials = new Uint16Array(MATCH_MAX_CLIENTS);
  /**
   * Per slot: the movement-event history entities carry (M3 design §2.4): a wrapping 8-bit count
   * and the two newest (kind, value), newest first at `slot * 2`. Kept across the slot's players
   * like the teleport counter, so a slot's count never steps back on a client.
   */
  private readonly eventSeqs = new Uint8Array(MATCH_MAX_CLIENTS);
  private readonly evKinds = new Uint8Array(MATCH_MAX_CLIENTS * ENTITY_EVENT_SLOTS);
  private readonly evValues = new Uint8Array(MATCH_MAX_CLIENTS * ENTITY_EVENT_SLOTS);
  /** pmove's events of the client in hand. */
  private readonly events = new PmoveEvents();
  private readonly event = new PmoveEvent();
  private readonly ping = new PingMsg();
  private readonly pong = new PongMsg();
  private readonly cvarsMsg = new CvarsMsg();
  private readonly cmdMsg = new CmdMsg();
  private readonly printMsg = new PrintMsg();
  private readonly kickMsg = new KickMsg();
  /** The cmd simulated for the client in hand. */
  private readonly cmd = new UserCmd();

  constructor(options: MatchOptions) {
    const cmap = options.cmap;
    this.world = options.world ?? buildCollisionWorld(cmap);
    this.log = options.log ?? ignoreLog;
    let cvars = options.cvars;
    if (cvars === undefined) {
      cvars = new CvarRegistry();
      registerPmoveCvars(cvars);
    }
    this.cvars = cvars;
    this.buildHash = options.buildHash;
    this.strictBuild = options.strictBuild ?? true;
    this.maxClients = effectiveMaxClients(options.maxClients ?? MATCH_DEFAULT_MAX_CLIENTS);
    this.mapName = cmap.name;
    this.mapHashHi = Number.parseInt(cmap.contentHash.slice(0, 8), 16);
    this.mapHashLo = Number.parseInt(cmap.contentHash.slice(8, 16), 16);

    this.spawns = new SpawnRotation(cmap, this.world, this.log);

    this.refreshCvars();
    this.blockEffectiveTick = 0;
    // Setup-time check that the map name, map hash, build hash and block fit WELCOME.
    if (!this.encodeWelcomeFor(0)) {
      throw new Error(`map ${cmap.name} or build ${this.buildHash} does not fit WELCOME`);
    }
  }

  /** The last tick simulated (and snapshotted); 0 before the first `tick()`. */
  get serverTick(): number {
    return this.currentTick;
  }

  /** The replicated cvar block's hash (u32) that ticks are simulated with now. */
  get cvarHash(): number {
    return this.blockHash;
  }

  /** The first tick simulated with the current block (0 for the values the match started with). */
  get cvarsEffectiveTick(): number {
    return this.blockEffectiveTick;
  }

  get sessionCount(): number {
    return this.sessions.length;
  }

  /** The session with `clientId`, or undefined. */
  session(clientId: number): Session | undefined {
    return this.sessions.find((s) => s.clientId === clientId);
  }

  /**
   * Adds a client on `transport`; it gets a WELCOME once its HELLO arrives. Returns the session,
   * or null (after a KICK) when the match holds `maxClients` already.
   */
  connect(transport: Transport, admin = false): Session | null {
    const id = freeClientId(this.sessions, this.maxClients);
    if (id < 0) {
      this.sendKickTo(transport, "server full");
      return null;
    }
    const s = new Session(id, transport, admin);
    const serial = ((this.serials[id] as number) + 1) & 0xffff;
    this.serials[id] = serial;
    s.serial = serial;
    let at = 0;
    while (at < this.sessions.length && (this.sessions[at] as Session).clientId < id) at++;
    this.sessions.splice(at, 0, s);
    transport.onMessage((d, len, reliable) => this.receive(s, d, len, reliable));
    transport.onClose((reason) => {
      if (s.state === SESSION_CLOSED) return;
      s.state = SESSION_CLOSED;
      this.anyClosed = true;
      this.log("info", `client ${s.clientId} disconnected${reason === "" ? "" : `: ${reason}`}`);
    });
    this.log("info", `client ${id} connected${admin ? " (admin)" : ""}`);
    return s;
  }

  /** Sends KICK with `reason`, closes the transport and drops the session after this poll. */
  kick(s: Session, reason: string): void {
    if (s.state === SESSION_CLOSED) return;
    this.sendKickTo(s.transport, reason);
    s.state = SESSION_CLOSED;
    this.anyClosed = true;
    this.metrics.kicks++;
    this.log("info", `client ${s.clientId} kicked: ${reason}`);
  }

  tick(): void {
    const t = this.currentTick + 1;
    if (t > TICK_MAX) return;
    const sessions = this.sessions;
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i] as Session;
      s.snapFlags = 0;
      if (s.state !== SESSION_CLOSED) s.transport.poll();
    }
    if (this.anyClosed) this.removeClosed();
    if (this.cvars.version !== this.cvarVersion && this.refreshCvars()) {
      this.blockEffectiveTick = t;
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i] as Session;
        if (s.state === SESSION_WELCOMED || s.state === SESSION_ACTIVE) this.sendCvars(s);
      }
    }
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i] as Session;
      if (s.state !== SESSION_ACTIVE) continue;
      if (s.spawnTick !== t) this.simulate(s, t);
      else s.queue.skip(t);
    }
    this.capture(t);
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i] as Session;
      if (s.state === SESSION_ACTIVE) this.sendSnapshot(s, t);
    }
    this.currentTick = t;
    this.metrics.ticks++;
  }

  // -------------------------------------------------------------------------------------------
  // Receiving

  private strike(s: Session): void {
    s.stats.strikes++;
    this.metrics.strikes++;
  }

  private receive(s: Session, d: Uint8Array, len: number, reliable: boolean): void {
    if (s.state === SESSION_CLOSED) return;
    const type = peekMessageType(d, len);
    const r = this.reader;
    r.reset(d, len);
    // Each message has its channel (docs/05 §3.3); one on the other channel is dropped.
    if (type === MSG_INPUT) {
      if (reliable || !decodeInput(r, this.input)) this.strike(s);
      else if (s.state === SESSION_ACTIVE) this.queueInput(s);
    } else if (type === MSG_PING) {
      if (reliable || !decodePing(r, this.ping)) this.strike(s);
      else if (s.state !== SESSION_CONNECTING) this.sendPong(s);
    } else if (!reliable) {
      this.strike(s);
    } else if (type === MSG_HELLO) {
      this.onHello(s, d, len);
    } else if (type === MSG_READY) {
      if (s.state !== SESSION_WELCOMED || !decodeReady(r)) this.strike(s);
      else this.join(s, this.currentTick + 1);
    } else if (type === MSG_CMD) {
      if (s.state === SESSION_CONNECTING || !decodeCmd(r, this.cmdMsg)) this.strike(s);
      else this.onCmd(s, this.cmdMsg.text);
    } else {
      this.strike(s);
    }
  }

  private queueInput(s: Session): void {
    const m = this.input;
    const q = s.queue;
    for (let i = 0; i < m.count; i++) q.push(m.cmds[i] as UserCmd);
  }

  private onHello(s: Session, d: Uint8Array, len: number): void {
    if (s.state !== SESSION_CONNECTING) {
      this.strike(s);
      return;
    }
    // The version first, from HELLO's frozen first 3 B, so a newer client hears why (D-026).
    const version = peekHelloVersion(d, len);
    if (version >= 0 && version !== PROTOCOL_VERSION) {
      this.kick(
        s,
        `protocol version ${version} is not supported; this server speaks ${PROTOCOL_VERSION}`,
      );
      return;
    }
    if (version < 0 || !decodeHello(this.reader, this.hello)) {
      this.strike(s);
      this.kick(s, "malformed HELLO");
      return;
    }
    const otherBuild = this.hello.buildHash !== this.buildHash;
    if (otherBuild && this.strictBuild) {
      this.kick(s, `build ${this.hello.buildHash} does not match the server's ${this.buildHash}`);
      return;
    }
    s.nonce = this.hello.nonce;
    s.buildHash = this.hello.buildHash;
    if (!this.encodeWelcomeFor(s.clientId)) {
      DEV_ASSERT(false, "WELCOME did not encode");
      this.kick(s, "server error");
      return;
    }
    s.transport.sendReliable(this.writer.bytes, this.writer.byteLength);
    s.state = SESSION_WELCOMED;
    if (otherBuild) {
      this.sendPrint(
        s,
        PRINT_WARN,
        `build ${this.hello.buildHash} differs from the server's ${this.buildHash}; ` +
          "sv_strictBuild 0 lets it play, but the two may disagree",
      );
    }
  }

  private onCmd(s: Session, text: string): void {
    const result = runServerCommand(text, this.cvars, s.admin);
    if (result.text !== "") this.sendPrint(s, result.level, result.text);
    if (result.resendCvars) this.sendCvars(s);
  }

  // -------------------------------------------------------------------------------------------
  // Simulation

  /**
   * Respawns an active player at the next spawn point on the next tick (M3 design §2.4; tests now,
   * deaths and rounds in later milestones): its teleport counter steps, so every client snaps it,
   * its own prediction included, even if the spawn tick's snapshot is lost (D-035). The cmds it
   * has queued stay: they are what its client re-simulates the spawn state with once it sees the
   * new counter, so a respawn costs no correction and no starved tick. The player faces the
   * point's yaw on the spawn tick only: from the next tick its own cmds aim it, so it keeps the
   * client's view direction (D-035; turning the client's view waits for deaths and rounds). False
   * (nothing done) when the session is not active.
   */
  respawn(s: Session): boolean {
    if (s.state !== SESSION_ACTIVE) return false;
    this.spawn(s, this.currentTick + 1);
    this.log("info", `client ${s.clientId} respawned at tick ${s.spawnTick}`);
    return true;
  }

  /**
   * READY: the player joins the team with fewer active players (team 1 on a tie; D-034) and
   * spawns, with an empty input queue that takes cmds from the next tick on.
   */
  private join(s: Session, t: number): void {
    let team1 = 0;
    let team2 = 0;
    const sessions = this.sessions;
    for (let i = 0; i < sessions.length; i++) {
      const o = sessions[i] as Session;
      if (o.state !== SESSION_ACTIVE) continue;
      if (o.team === TEAM_1) team1++;
      else if (o.team === TEAM_2) team2++;
    }
    s.team = assignTeam(team1, team2);
    s.queue.reset(t + 1);
    this.spawn(s, t);
    s.state = SESSION_ACTIVE;
    this.log("info", `client ${s.clientId} spawned at tick ${t} on team ${s.team}`);
  }

  /**
   * The player appears at the next spawn point of the rotation at rest, facing its yaw, with full
   * stamina, grounded if the ground trace finds walkable ground. Its state at tick `t` is this
   * spawn state; simulation starts at t + 1, and the slot's teleport counter steps (D-035). The
   * repeated cmd for a starved tick starts as a neutral one with the spawn yaw, which is what the
   * client predicts with before its first real cmd (M2 design §2, "Client clock"); a joining
   * client takes its view from the spawn state, so it keeps facing the yaw, while a respawned
   * one's cmds turn it back to its own view from t + 1.
   */
  private spawn(s: Session, t: number): void {
    const ps: PlayerState = s.player;
    const spawns = this.spawns;
    const point = spawns.take();
    const yaw = spawns.yaw(point);
    spawns.origin(point, ps.origin);
    ps.velocity.fill(0);
    ps.viewYaw = yaw;
    ps.viewPitch = 0;
    ps.flags = 0;
    ps.groundEntity = ENTITY_NONE;
    ps.waterLevel = 0;
    ps.stamina = SPAWN_STAMINA;
    groundTrace(ps, this.world, this.params, HULL_MINS, HULL_STANDING_MAXS, false, null);
    quantizePlayerState(ps);
    const c = s.lastCmd;
    c.tick = t;
    c.buttons = 0;
    c.forward = 0;
    c.right = 0;
    c.up = 0;
    c.yaw = yaw;
    c.pitch = 0;
    c.weaponSlot = 0;
    s.spawnTick = t;
    const id = s.clientId;
    this.teleportSeqs[id] = ((this.teleportSeqs[id] as number) + 1) & 0xff;
  }

  private simulate(s: Session, t: number): void {
    const cmd = this.cmd;
    if (s.queue.take(t, cmd)) {
      s.stats.cmds++;
    } else {
      // docs/05 §8.1 step 2: repeat the last cmd, but never a shot the client didn't send.
      copyUserCmd(cmd, s.lastCmd);
      cmd.buttons &= ~BUTTON_ATTACK;
      cmd.tick = t;
      s.stats.starved++;
      s.snapFlags |= SNAP_FLAG_STARVED;
      this.metrics.starved++;
    }
    sanitizeUserCmd(cmd);
    copyUserCmd(s.lastCmd, cmd);
    const events = this.events;
    events.clear();
    pmove(s.player, cmd, this.world, this.params, TICK_DT, events, null);
    // Oldest first, so the newest ends first in the slot's history (docs/05 §10).
    const ev = this.event;
    const id = s.clientId;
    for (let i = 0; i < events.count; i++) {
      events.read(i, ev);
      pushEntityEvent(
        this.eventSeqs,
        this.evKinds,
        this.evValues,
        id,
        ev.type,
        entityEventValue(ev),
      );
    }
  }

  /** Copies the registry into the params and the block; true when the replicated block changed. */
  private refreshCvars(): boolean {
    const reg = this.cvars;
    this.cvarVersion = reg.version;
    refreshPmoveParams(reg, this.params);
    const hash = registryCvarHash(reg);
    if (hash < 0) throw new Error("the replicated cvars do not fit the cvar block");
    if (hash === this.blockHash && this.block.entries.length > 0) return false;
    captureCvarBlock(reg, this.block);
    this.blockHash = hash;
    this.blockHash16 = cvarHash16(hash);
    return true;
  }

  private removeClosed(): void {
    const sessions = this.sessions;
    let n = 0;
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i] as Session;
      if (s.state !== SESSION_CLOSED) sessions[n++] = s;
    }
    sessions.length = n;
    this.anyClosed = false;
  }

  // -------------------------------------------------------------------------------------------
  // Sending

  private encodeWelcomeFor(clientId: number): boolean {
    const m = this.welcome;
    m.protocolVersion = PROTOCOL_VERSION;
    m.clientId = clientId;
    m.tickRate = TICK_RATE;
    m.serverTick = this.currentTick;
    m.mapName = this.mapName;
    m.mapHashLo = this.mapHashLo;
    m.mapHashHi = this.mapHashHi;
    m.cvars.entries.length = 0;
    for (const e of this.block.entries) m.cvars.entries.push(e);
    const w = this.writer;
    w.reset();
    return encodeWelcome(w, m);
  }

  /**
   * The world frame of tick `t`: every active player (stamp t), its serial, team, teleport counter
   * and event history.
   */
  private capture(t: number): void {
    const f = this.worldFrame;
    f.clear();
    const sessions = this.sessions;
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i] as Session;
      if (s.state !== SESSION_ACTIVE) continue;
      const id = s.clientId;
      f.setPresent(id, t);
      playerStateToSlot(f, id, s.player);
      f.serial[id] = s.serial;
      f.team[id] = s.team;
      f.teleportSeq[id] = this.teleportSeqs[id] as number;
      f.eventSeq[id] = this.eventSeqs[id] as number;
      const e = id * ENTITY_EVENT_SLOTS;
      f.evKind[e] = this.evKinds[e] as number;
      f.evValue[e] = this.evValues[e] as number;
      f.evKind[e + 1] = this.evKinds[e + 1] as number;
      f.evValue[e + 1] = this.evValues[e + 1] as number;
    }
  }

  private sendSnapshot(s: Session, t: number): void {
    const h = this.snapHeader;
    h.serverTick = t;
    h.baseBack = 0;
    h.flags = s.snapFlags;
    h.cvarHash = this.blockHash16;
    h.inputBufferHealth = Math.max(-128, Math.min(127, s.queue.newestTick - t));
    const w = this.writer;
    w.reset();
    // Up to SNAP_FIT_MAX_PLAYERS every full snapshot fits 1100 B (D-034), so a failure is a bug.
    if (!encodeSnapshot(w, h, this.worldFrame, null, s.clientId)) {
      DEV_ASSERT(false, "SNAPSHOT did not encode", s.clientId);
      return;
    }
    s.transport.sendUnreliable(w.bytes, w.byteLength);
    s.stats.snapshots++;
    this.metrics.snapshots++;
  }

  private sendPong(s: Session): void {
    const m = this.pong;
    m.pingId = this.ping.pingId;
    m.serverTick = this.currentTick;
    const w = this.writer;
    w.reset();
    if (encodePong(w, m)) s.transport.sendUnreliable(w.bytes, w.byteLength);
  }

  /** The block simulated now, with the tick it took effect (a broadcast or a resend). */
  private sendCvars(s: Session): void {
    const m = this.cvarsMsg;
    m.effectiveTick = this.blockEffectiveTick;
    m.block.entries.length = 0;
    for (const e of this.block.entries) m.block.entries.push(e);
    const w = this.writer;
    w.reset();
    if (!encodeCvars(w, m)) {
      DEV_ASSERT(false, "CVARS did not encode");
      return;
    }
    s.transport.sendReliable(w.bytes, w.byteLength);
    this.metrics.cvarsSent++;
  }

  private sendPrint(s: Session, level: number, text: string): void {
    const m = this.printMsg;
    m.level = level;
    m.text = text;
    const w = this.writer;
    w.reset();
    if (encodePrint(w, m)) s.transport.sendReliable(w.bytes, w.byteLength);
    else this.log("warn", `client ${s.clientId}: reply did not fit PRINT`);
  }

  private sendKickTo(transport: Transport, reason: string): void {
    const m = this.kickMsg;
    m.reason = reason;
    const w = this.writer;
    w.reset();
    if (!encodeKick(w, m)) {
      m.reason = "kicked";
      w.reset();
      encodeKick(w, m);
    }
    transport.sendReliable(w.bytes, w.byteLength);
    transport.close(reason);
  }
}
