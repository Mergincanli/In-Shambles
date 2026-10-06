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
  copyPlayerState,
  copyUserCmd,
  cvarHash16,
  DEV_ASSERT,
  decodeCmd,
  decodeHello,
  decodeInput,
  decodePing,
  decodeReady,
  degreesToU16,
  ENTITY_NONE,
  encodeCvars,
  encodeKick,
  encodePong,
  encodePrint,
  encodeSnapshot,
  encodeWelcome,
  groundTrace,
  HelloMsg,
  HULL_MINS,
  HULL_STANDING_MAXS,
  InputMsg,
  KickMsg,
  MASK_PLAYERSOLID,
  MAX_RELIABLE_BYTES,
  MSG_CMD,
  MSG_HELLO,
  MSG_INPUT,
  MSG_PING,
  MSG_READY,
  PingMsg,
  type PlayerState,
  PmoveParams,
  PongMsg,
  PROTOCOL_VERSION,
  PrintMsg,
  peekHelloVersion,
  peekMessageType,
  pmove,
  positionTest,
  quantizePlayerState,
  refreshPmoveParams,
  registerPmoveCvars,
  registryCvarHash,
  SNAP_FLAG_STARVED,
  SNAP_FLAG_TELEPORT,
  SnapshotMsg,
  sanitizeUserCmd,
  TICK_DT,
  TICK_MAX,
  TICK_RATE,
  TRACE_EPSILON,
  type Transport,
  UserCmd,
  type Vec3,
  vec3,
  WelcomeMsg,
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

/**
 * Most clients one match takes (a design constant above the 16-player budget of docs/05 §9.2;
 * client ids are 0..MATCH_MAX_CLIENTS − 1, which fits WELCOME's u8).
 */
export const MATCH_MAX_CLIENTS = 64;

/** Stamina at spawn, in hundredths: staminaMax = health 100 with no vest (docs/03 §5.2, FACT). */
export const SPAWN_STAMINA = 100 * 100;

/** Classname of the M2 spawn point (docs/07 §3). */
export const SPAWN_CLASSNAME = "info_player_start";

export interface MatchOptions {
  readonly cmap: Cmap;
  /** Built from `cmap` when absent. */
  readonly world?: CollisionWorld;
  /** The server's registry; a new one with the pmove cvars when absent. */
  readonly cvars?: CvarRegistry;
  /** HELLO's buildHash must equal it (short ASCII). */
  readonly buildHash: string;
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

/** Lowest free client id, or −1 when every id is taken. `sessions` is sorted by id. */
function freeClientId(sessions: readonly Session[]): number {
  let id = 0;
  for (let i = 0; i < sessions.length; i++) {
    if ((sessions[i] as Session).clientId !== id) break;
    id++;
  }
  return id < MATCH_MAX_CLIENTS ? id : -1;
}

/**
 * One match (docs/05 §8.1, M2 design §2, D-027): its world, the server's cvars and every client
 * session, advanced one tick per `tick()`. Environment-agnostic: no clock, timer or I/O of its
 * own (the loop and the transports bring them), so the same code runs in the Worker and in Node.
 *
 * `tick()` simulates T = serverTick + 1, in this order:
 * 1. Poll every session's transport in client-id order and handle what arrived: HELLO (version
 *    and build checked, else KICK; then WELCOME), READY (spawn), INPUT (into the input queue),
 *    PING (PONG), CMD (console commands; changing cvars needs the admin flag).
 * 2. If the cvars changed: refresh the pmove params and, when the replicated block changed,
 *    broadcast CVARS with effectiveTick = T, the first tick simulated with the new values.
 * 3. Per active client in id order: take its cmd for T, or repeat its last cmd with ATTACK cleared
 *    and tick = T (starved); sanitize; pmove. A player spawned this tick is not simulated: its
 *    spawn state is its state at T.
 * 4. Per active client: a SNAPSHOT of T with lastProcessedCmdTick = T and inputBufferHealth =
 *    newest cmd tick received − T (clamped to i8), flagged STARVED or TELEPORT.
 * 5. Metrics.
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
  /** Spawn origin, raised to the D-017 rest height, and yaw (u16). */
  readonly spawnOrigin: Vec3 = vec3();
  readonly spawnYaw: number;

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
  private readonly snapshot = new SnapshotMsg();
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
    this.mapName = cmap.name;
    this.mapHashHi = Number.parseInt(cmap.contentHash.slice(0, 8), 16);
    this.mapHashLo = Number.parseInt(cmap.contentHash.slice(8, 16), 16);

    const spawn = cmap.entities.find((e) => e.classname === SPAWN_CLASSNAME);
    if (spawn?.origin === undefined) {
      throw new Error(`map ${cmap.name} has no ${SPAWN_CLASSNAME} with an origin`);
    }
    // A fresh spawn rests one ε above the floor, as a landed player does (D-017, D-027): with its
    // feet exactly on the floor it would meet a steep wedge's toe as a wall (D-023 "Steep toes").
    this.spawnOrigin[0] = spawn.origin[0];
    this.spawnOrigin[1] = spawn.origin[1];
    this.spawnOrigin[2] = spawn.origin[2] + TRACE_EPSILON;
    this.spawnYaw = degreesToU16(spawn.angles?.[1] ?? 0);
    if (
      !positionTest(this.world, this.spawnOrigin, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID)
    ) {
      this.log("warn", `map ${cmap.name}: ${SPAWN_CLASSNAME} is inside solid`);
    }

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
   * or null (after a KICK) when the match is full.
   */
  connect(transport: Transport, admin = false): Session | null {
    const id = freeClientId(this.sessions);
    if (id < 0) {
      this.sendKickTo(transport, "server full");
      return null;
    }
    const s = new Session(id, transport, admin);
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
      if (s.state === SESSION_ACTIVE && s.spawnTick !== t) this.simulate(s, t);
    }
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
      else this.spawn(s, this.currentTick + 1);
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
    if (this.hello.buildHash !== this.buildHash) {
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
  }

  private onCmd(s: Session, text: string): void {
    const result = runServerCommand(text, this.cvars, s.admin);
    if (result.text !== "") this.sendPrint(s, result.level, result.text);
    if (result.resendCvars) this.sendCvars(s);
  }

  // -------------------------------------------------------------------------------------------
  // Simulation

  /**
   * READY: the player appears at the spawn point at rest, facing its yaw, with full stamina,
   * grounded if the ground trace finds walkable ground. Its state at tick `t` is this spawn
   * state; simulation starts at t + 1, and the snapshot of `t` carries TELEPORT. The repeated cmd
   * for a starved tick starts as a neutral one with the spawn yaw, which is what the client
   * predicts with before its first real cmd (M2 design §2, "Client clock").
   */
  private spawn(s: Session, t: number): void {
    const ps: PlayerState = s.player;
    ps.origin.set(this.spawnOrigin);
    ps.velocity.fill(0);
    ps.viewYaw = this.spawnYaw;
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
    c.yaw = this.spawnYaw;
    c.pitch = 0;
    c.weaponSlot = 0;
    s.queue.reset(t + 1);
    s.spawnTick = t;
    s.state = SESSION_ACTIVE;
    s.snapFlags |= SNAP_FLAG_TELEPORT;
    this.log("info", `client ${s.clientId} spawned at tick ${t}`);
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
    pmove(s.player, cmd, this.world, this.params, TICK_DT, null, null);
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

  private sendSnapshot(s: Session, t: number): void {
    const m = this.snapshot;
    m.serverTick = t;
    m.baselineTick = 0;
    m.lastProcessedCmdTick = t;
    m.inputBufferHealth = Math.max(-128, Math.min(127, s.queue.newestTick - t));
    m.cvarHash = this.blockHash16;
    m.flags = s.snapFlags;
    copyPlayerState(m.state, s.player);
    const w = this.writer;
    w.reset();
    if (!encodeSnapshot(w, m)) {
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
