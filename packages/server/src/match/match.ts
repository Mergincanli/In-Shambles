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
  DEMO_NAME,
  DEMO_REC_CVARS,
  DEV_ASSERT,
  decodeCmd,
  decodeHello,
  decodeInput,
  decodePing,
  decodeReady,
  demoHeaderProblem,
  ENTITY_EVENT_SLOTS,
  ENTITY_NONE,
  EV_LEAVE_KICKED,
  EV_LEAVE_LEFT,
  EV_LEAVE_TIMED_OUT,
  EVENT_TICK_US_MAX,
  EVENTS_MAX_PER_MSG,
  EVK_PLAYER_JOIN,
  EVK_PLAYER_LEAVE,
  EVK_SERVER_STATS,
  type EventRecord,
  EventsMsg,
  encodeCvars,
  encodeEvents,
  encodeKick,
  encodePong,
  encodePrint,
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
  MAX_UNRELIABLE_BYTES,
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
  PRINT_ERROR,
  PRINT_WARN,
  PROTOCOL_VERSION,
  PrintMsg,
  peekHelloVersion,
  peekMessageType,
  playerStateToSlot,
  pmove,
  primePmoveOnce,
  pushEntityEvent,
  quantizePlayerState,
  refreshPmoveParams,
  registerPmoveCvars,
  registerServerReplicatedCvars,
  registryCvarHash,
  SNAP_FIT_MAX_PLAYERS,
  SNAP_FLAG_STARVED,
  SNAP_STARVE_SEQ_MASK,
  SnapshotHeader,
  sanitizeUserCmd,
  TEAM_1,
  TEAM_2,
  TEXT_MAX,
  TICK_DT,
  TICK_MAX,
  TICK_RATE,
  type Transport,
  UserCmd,
  WelcomeMsg,
  type WorldFrame,
} from "@game/shared";
import {
  type AdminReply,
  type CommandResult,
  type MatchAdmin,
  parseRcon,
  runServerCommand,
} from "./commands";
import { type DemoHost, DemoRecorder, type DemoSink } from "./demo";
import { ACK_AHEAD, ACK_AHEAD_STRIKES, acceptAck, WorldHistory } from "./history";
import type { MatchEventLog, MatchLog, RconGate } from "./host";
import {
  RELIABLE_REFILL_UNITS,
  SessionLimits,
  STRIKE_KICK,
  STRIKE_MALFORMED,
  STRIKE_RATE_LIMITED,
  STRIKE_RCON,
  STRIKE_UNEXPECTED,
  STRIKE_WARN,
  UNRELIABLE_REFILL_UNITS,
} from "./limits";
import { MirrorPool } from "./mirror";
import { buildSnapshot, SnapshotScheduler } from "./scheduler";
import {
  EventOutbox,
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
 * The cap a match applies for `sv_maxClients` = `requested`: 1 to MATCH_MAX_CLIENTS (64; D-034).
 * Above SNAP_FIT_MAX_PLAYERS (37) a snapshot's worst case no longer fits 1100 B and the byte-budget
 * scheduler keeps it within (D-046). A non-finite request (NaN would pass Math.min/max) takes the
 * default.
 */
export function effectiveMaxClients(requested: number): number {
  const n = Number.isFinite(requested) ? Math.floor(requested) : MATCH_DEFAULT_MAX_CLIENTS;
  return Math.max(1, Math.min(MATCH_MAX_CLIENTS, n));
}

/**
 * Ticks between SERVER_STATS events (D-043; design: once a second at 60 Hz): sent on every tick
 * that is a multiple of it, with the tick times the host last reported.
 */
export const SERVER_STATS_INTERVAL_TICKS = TICK_RATE;

/** What sending EVENTS needs from a target: a session's transport, or the demo recorder (D-044). */
export type EventsTarget = Pick<Transport, "sendReliable">;

/** Stamina at spawn, in hundredths: staminaMax = health 100 with no vest (docs/03 §5.2, FACT). */
export const SPAWN_STAMINA = 100 * 100;

export interface MatchOptions {
  readonly cmap: Cmap;
  /** Built from `cmap` when absent. */
  readonly world?: CollisionWorld;
  /**
   * The server's registry; when absent a new one with the replicated set (`registerPmoveCvars`,
   * `registerServerReplicatedCvars`) at its defaults.
   */
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
   * "server full". Above 37 every session gets a mirror for the byte-budget scheduler (D-046).
   */
  readonly maxClients?: number;
  readonly log?: MatchLog;
  /**
   * Session events (`welcome`, `ready`, `leave`, `kick` with its reason and strike score) as
   * structured fields: the Node server logs each as its own JSON line (docs/06 §8). When absent
   * they are text lines of `log`.
   */
  readonly events?: MatchEventLog;
  /**
   * Kick sessions that stay silent or never finish the handshake (D-041: `sv_timeout`,
   * `sv_helloTimeout`, `sv_handshakeTimeout`). Default false: the Worker's one client must survive
   * a hidden tab for as long as it likes; the Node server turns them on.
   */
  readonly timeouts?: boolean;
  /**
   * Rate limits, strike levels, timeouts and the starved-cmd limit (D-041); the defaults when
   * absent. Read when the match is built and whenever a session connects (the buckets' sizes).
   */
  readonly limits?: SessionLimits;
  /**
   * Run the pmove primer (D-040) at construction, once per module instance (default true): it
   * warms pmove's late branches before the first tick. Unit helpers that build many matches pass
   * false to save its cost; it never changes a result.
   */
  readonly primer?: boolean;
  /**
   * Checks an rcon password (D-042, M3 design §2.10): the Node server compares it with
   * `SV_RCON_PASSWORD` in constant time. Absent: rcon is disabled (the Worker's client is admin
   * anyway). The match never logs or echoes the password, nor the rcon line it came in (a kick's
   * reason is logged as any kick's is).
   */
  readonly rcon?: (password: string) => boolean;
  /** Per-address lockout after failed rcon passwords (the Node server's `RconGuard`). */
  readonly rconGate?: RconGate;
  /**
   * `metrics reset` from rcon or this match's console: restarts this match's metrics run window
   * only (M3 design §2.14) and returns the reply. Absent: the match has no metrics to reset.
   */
  readonly metricsReset?: () => string;
  /**
   * Opens demo files for `record` (D-044): the Node server's writer, confined to its demos folder.
   * Absent: the match records only through `startRecording` (tests); `record` replies that it
   * cannot.
   */
  readonly demos?: DemoHost;
}

/** Match-wide counters (live). */
export class MatchMetrics {
  ticks = 0;
  /** Starved player-ticks, all clients. */
  starved = 0;
  /** Strikes, all clients. */
  strikes = 0;
  snapshots = 0;
  /** Snapshots sent without a baseline: a session's first, any without a usable ack (D-038). */
  fullSnapshots = 0;
  /**
   * The byte-budget scheduler (D-046): snapshots whose worst case did not fit (the size pass ran),
   * players left out (deferred ids, plus reused slots sent as removals) and the snapshots that
   * left any out, and the largest staleness of a remote at send (1 without deferral, 2 at most).
   */
  sizePasses = 0;
  deferredEntities = 0;
  deferredSnapshots = 0;
  maxStaleness = 0;
  /** Snapshots whose encode failed, so nothing went out (impossible by the bound; logged). */
  snapshotOverflow = 0;
  /** Snapshots that had to leave out a player due this tick (impossible by the bound). */
  schedOverrun = 0;
  kicks = 0;
  /** Packets dropped by the rate limits (D-041), and the player-ticks that dropped any. */
  rateLimited = 0;
  rateLimitedTicks = 0;
  /** INPUT packets received, and those their `packetSeq` shows were lost on the way (D-041). */
  inputPackets = 0;
  inputLost = 0;
  /** Starved player-ticks simulated with the neutral cmd (past `sv_starveNeutralTicks`). */
  neutralTicks = 0;
  /** CVARS messages sent (broadcasts and resends). */
  cvarsSent = 0;
  /** EVENTS messages sent (D-043), all clients. */
  eventsSent = 0;
  /** rcon commands run, and refused for a wrong password or a locked address (D-042). */
  rconOk = 0;
  rconFailed = 0;
  rconLocked = 0;
  /** Demo records written and demo snapshots that failed to encode (D-044), all recordings. */
  demoRecords = 0;
  demoFailed = 0;
}

function ignoreLog(): void {}

/** A host-reported time in whole µs, saturated to SERVER_STATS' 16 bits; NaN and ±∞ read 0. */
function saturateUs(us: number): number {
  if (!Number.isFinite(us)) return 0;
  return Math.max(0, Math.min(EVENT_TICK_US_MAX, Math.floor(us)));
}

/** The PRINT a session gets when its strike score first reaches `sv_strikeWarn` (D-041). */
function strikeWarning(score: number, kick: number): string {
  return `too many bad packets (${score} strike points); the server disconnects at ${kick}`;
}

const STATE_NAMES = ["connecting", "welcomed", "active", "closed"];

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
 * `tick()` simulates T = serverTick + 1, in this order (M3 design §2.5):
 * 1. Per session in client-id order: refill its two token buckets, then poll its transport and
 *    handle what arrived. An unreliable message over 1200 B is struck; one whose channel's bucket
 *    is empty is dropped (the tick is rate-limited). Then HELLO (version and build checked, else
 *    KICK; then WELCOME), READY (a team, then a spawn at the next point of the rotation), INPUT
 *    (into the input queue; its ack and packet sequence read), PING (PONG), CMD (console commands;
 *    changing cvars needs the admin flag, which `rcon` grants for one command, D-042). What doesn't
 *    decode, fit the channel or fit the state is struck by weight (D-041); a session whose score
 *    reaches `sv_strikeKick` is KICKed at once.
 * 2. With `timeouts`: KICK a session without HELLO after `sv_helloTimeout` ticks, one not READY
 *    after `sv_handshakeTimeout`, and a welcomed or active one silent for `sv_timeout`.
 * 3. Strikes: a rate-limited tick adds a point; scores decay 1 a second.
 * 4. If the cvars changed: refresh the pmove params and, when the replicated block changed,
 *    broadcast CVARS with effectiveTick = T, the first tick simulated with the new values.
 * 5. Per active client in id order: take its cmd for T, or repeat its last cmd with ATTACK cleared
 *    and tick = T (starved), a neutral one (no move, no buttons, same angles) once it has starved
 *    `sv_starveNeutralTicks` ticks in a row; sanitize; pmove, whose movement events join the slot's
 *    event history (the count and the two newest, as entities carry them). A player spawned this
 *    tick is not simulated: its spawn state is its state at T.
 * 6. Capture the world frame of T into the 64-tick world history every client's baseline comes
 *    from: every active player's state, serial, team, teleport counter and event history.
 * 7. Per active client: the SNAPSHOT of T (protocol v3, D-033, D-038): a delta against the frame of
 *    the newest valid tick the client acked (`lastSnapshotTick` of its INPUTs), or a full one when
 *    none is usable; its own state as the local block, every other active player as an entity
 *    record, inputBufferHealth = newest cmd tick received − T (clamped to i8), flagged STARVED
 *    when step 5 starved the client at T, with the client's starve counter (D-050).
 *    When its worst case is past 1100 B the byte-budget scheduler (D-046, `scheduler.ts`) leaves
 *    some players out, never one two ticks in a row; the tick counts as sent only once it encoded.
 *    Then its EVENTS (D-043): the roster changes since its last flush (its JOIN burst when it has
 *    just joined: every player present, then itself; then each JOIN and LEAVE), and on every 60th
 *    tick SERVER_STATS with the tick times the host last reported (`reportTickStats`; the match
 *    never reads a clock) and the players in the match, at most 63 events a message.
 * 8. While recording a demo (D-044, `demo.ts`): the tick's CVARS when the block changed, the
 *    spectator snapshot of every player, and the tick's broadcast EVENTS (the roster as a JOIN
 *    burst on the first tick instead).
 * 9. Metrics.
 *
 * After warm-up a tick allocates nothing: messages decode into and encode from preallocated
 * structs, and the transports pool their packets. HELLO, CMD, kicks and cvar changes allocate
 * (rare reliable traffic).
 */
export class Match implements MatchAdmin {
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
  /** Admitted players, `sv_maxClients` after `effectiveMaxClients` (`setMaxClients` changes it). */
  private cap: number;
  /**
   * The world frames of the last 64 ticks (D-038): each snapshot is encoded from the newest, as a
   * delta against the one its client acked.
   */
  readonly history = new WorldHistory();

  /**
   * Spare `ClientMirror`s (D-046), and whether sessions get one: from the moment the match admits
   * more than 37 players, and for the rest of its life (a session that joined above 37 may still
   * be present after the cap went down). A 32-player match never allocates one.
   */
  readonly mirrors = new MirrorPool();
  private mirrorsOn = false;
  private readonly scheduler = new SnapshotScheduler();

  private readonly log: MatchLog;
  private readonly sessionEvents: MatchEventLog | null;
  private readonly rconCheck: ((password: string) => boolean) | null;
  private readonly rconGate: RconGate | null;
  private readonly onMetricsReset: (() => string) | null;
  private readonly demoHost: DemoHost | null;
  /** The demo recorder, made by the first recording (D-044). */
  private recorder: DemoRecorder | null = null;
  /** This tick broadcast CVARS (step 4): a recording writes them too. */
  private cvarsChanged = false;
  /** A recording's first tick: the JOIN of every player present (as a joiner's burst). */
  private readonly demoBurst = new EventOutbox();
  /** Rate limits, strike levels and timeouts (D-041). */
  readonly limits: SessionLimits;
  private readonly timeouts: boolean;
  private readonly sessions: Session[] = [];
  private currentTick = 0;
  private anyClosed = false;
  /** Why the match closed (`close`), or null while it runs. */
  private closedReason: string | null = null;

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
  private readonly eventsMsg = new EventsMsg();
  /**
   * The JOINs and LEAVEs broadcast since the last tick ended (D-043), kept through the tick for
   * the demo sink (D-044) and emptied when it ends.
   */
  readonly tickEvents = new EventOutbox();
  /** This tick sends SERVER_STATS (every SERVER_STATS_INTERVAL_TICKS), and its player count. */
  private statsDue = false;
  private statsPlayers = 0;
  /**
   * p50, p99 and max tick time (µs, saturated at 65535) of the host's last report (0 before it),
   * which SERVER_STATS carries. Read-only outside the match.
   */
  readonly tickTimes = new Int32Array(3);
  /** The cmd simulated for the client in hand. */
  private readonly cmd = new UserCmd();

  constructor(options: MatchOptions) {
    const cmap = options.cmap;
    this.world = options.world ?? buildCollisionWorld(cmap);
    this.log = options.log ?? ignoreLog;
    this.sessionEvents = options.events ?? null;
    this.rconCheck = options.rcon ?? null;
    this.rconGate = options.rconGate ?? null;
    this.onMetricsReset = options.metricsReset ?? null;
    this.demoHost = options.demos ?? null;
    this.limits = options.limits ?? new SessionLimits();
    this.timeouts = options.timeouts ?? false;
    let cvars = options.cvars;
    if (cvars === undefined) {
      cvars = new CvarRegistry();
      registerPmoveCvars(cvars);
      registerServerReplicatedCvars(cvars);
    }
    this.cvars = cvars;
    this.buildHash = options.buildHash;
    this.strictBuild = options.strictBuild ?? true;
    this.cap = effectiveMaxClients(options.maxClients ?? MATCH_DEFAULT_MAX_CLIENTS);
    this.mirrorsOn = this.cap > SNAP_FIT_MAX_PLAYERS;
    this.mapName = cmap.name;
    this.mapHashHi = Number.parseInt(cmap.contentHash.slice(0, 8), 16);
    this.mapHashLo = Number.parseInt(cmap.contentHash.slice(8, 16), 16);

    this.spawns = new SpawnRotation(cmap, this.world, this.log);

    this.refreshCvars();
    if (options.primer ?? true) primePmoveOnce(this.params);
    this.blockEffectiveTick = 0;
    // Setup-time check that the map name, map hash, build hash and block fit WELCOME.
    if (!this.encodeWelcomeFor(0)) {
      throw new Error(`map ${cmap.name} or build ${this.buildHash} does not fit WELCOME`);
    }
  }

  /**
   * Every active player at the last tick simulated, as snapshots are encoded from it (D-034); an
   * empty frame before the first tick.
   */
  get worldFrame(): WorldFrame {
    return this.history.frameFor(this.currentTick);
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

  /** Players admitted (`sv_maxClients` after `effectiveMaxClients`). */
  get maxClients(): number {
    return this.cap;
  }

  /**
   * Changes the cap: sessions already present stay; new ones take ids below the new cap. Raising
   * it above 37 gives every session present a mirror now (outside the tick), so the scheduler
   * never allocates during one. Returns the effective cap. The hook for a runtime admin change:
   * none calls it yet, since `sv_maxClients` is a SERVER cvar read once at startup (docs/06 §8).
   */
  setMaxClients(requested: number): number {
    this.cap = effectiveMaxClients(requested);
    if (this.cap > SNAP_FIT_MAX_PLAYERS && !this.mirrorsOn) {
      this.mirrorsOn = true;
      for (const s of this.sessions) if (s.mirror === null) s.mirror = this.mirrors.acquire();
    }
    return this.cap;
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
    if (this.closedReason !== null) {
      this.sendKickTo(transport, this.closedReason);
      return null;
    }
    const id = freeClientId(this.sessions, this.maxClients);
    if (id < 0) {
      this.sendKickTo(transport, "server full");
      return null;
    }
    const s = new Session(id, transport, admin);
    if (this.mirrorsOn) s.mirror = this.mirrors.acquire();
    const limits = this.limits;
    s.unreliableTokens.configure(limits.inputBurst, UNRELIABLE_REFILL_UNITS);
    s.reliableTokens.configure(limits.reliableBurst, RELIABLE_REFILL_UNITS);
    s.connectTick = this.currentTick;
    s.lastPacketTick = this.currentTick;
    const serial = ((this.serials[id] as number) + 1) & 0xffff;
    this.serials[id] = serial;
    s.serial = serial;
    let at = 0;
    while (at < this.sessions.length && (this.sessions[at] as Session).clientId < id) at++;
    this.sessions.splice(at, 0, s);
    transport.onMessage((d, len, reliable) => this.receive(s, d, len, reliable));
    transport.onClose((reason) => {
      if (s.state === SESSION_CLOSED) return;
      const joined = s.state === SESSION_ACTIVE;
      s.state = SESSION_CLOSED;
      this.anyClosed = true;
      if (joined) this.announceLeave(s, EV_LEAVE_LEFT);
      if (this.sessionEvents !== null)
        this.sessionEvents("info", "leave", { client: s.clientId, reason });
      else
        this.log("info", `client ${s.clientId} disconnected${reason === "" ? "" : `: ${reason}`}`);
    });
    this.log("info", `client ${id} connected${admin ? " (admin)" : ""}`);
    return s;
  }

  /**
   * Sends KICK with `reason`, closes the transport and drops the session after this poll. A player
   * who had joined leaves the others' rosters with `leave` (an EV_LEAVE_* reason; kicked unless
   * said otherwise).
   */
  kick(s: Session, reason: string, leave = EV_LEAVE_KICKED): void {
    if (s.state === SESSION_CLOSED) return;
    const joined = s.state === SESSION_ACTIVE;
    this.sendKickTo(s.transport, reason);
    s.state = SESSION_CLOSED;
    this.anyClosed = true;
    if (joined) this.announceLeave(s, leave);
    this.metrics.kicks++;
    const strikes = s.strikeScore.score;
    if (this.sessionEvents !== null) {
      this.sessionEvents("info", "kick", { client: s.clientId, reason, strikes });
    } else {
      this.log("info", `client ${s.clientId} kicked: ${reason} (strike score ${strikes})`);
    }
  }

  /**
   * Closes the match for good (D-047's `match_remove`; called between ticks): ends its demo (the
   * END record, so the kicks are not in it), KICKs every session `reason` with LEAVE reason
   * kicked, drops the sessions with their mirrors and empties the mirror pool. Later ticks do
   * nothing and a later connect is KICKed `reason`. Returns the sessions it kicked; a second call
   * does nothing and returns 0.
   */
  close(reason: string): number {
    if (this.closedReason !== null) return 0;
    this.stopRecording();
    let kicked = 0;
    for (let i = 0; i < this.sessions.length; i++) {
      const s = this.sessions[i] as Session;
      if (s.state === SESSION_CLOSED) continue;
      this.kick(s, reason, EV_LEAVE_KICKED);
      kicked++;
    }
    this.removeClosed();
    this.mirrors.clear();
    this.closedReason = reason;
    return kicked;
  }

  /** Whether `close` ended the match. */
  get closed(): boolean {
    return this.closedReason !== null;
  }

  tick(): void {
    const t = this.currentTick + 1;
    if (t > TICK_MAX || this.closedReason !== null) return;
    const sessions = this.sessions;
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i] as Session;
      s.snapFlags = 0;
      if (s.state === SESSION_CLOSED) continue;
      s.unreliableTokens.refill();
      s.reliableTokens.refill();
      s.transport.poll();
    }
    if (this.timeouts) this.checkTimeouts(t);
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i] as Session;
      if (s.state === SESSION_CLOSED) continue;
      if (s.rateLimitedNow) {
        s.rateLimitedNow = false;
        s.stats.rateLimitedTicks++;
        this.metrics.rateLimitedTicks++;
        this.strike(s, STRIKE_RATE_LIMITED);
      }
      s.strikeScore.tick();
    }
    if (this.anyClosed) this.removeClosed();
    this.cvarsChanged = false;
    if (this.cvars.version !== this.cvarVersion && this.refreshCvars()) {
      this.blockEffectiveTick = t;
      this.cvarsChanged = true;
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
    this.statsDue = t % SERVER_STATS_INTERVAL_TICKS === 0;
    if (this.statsDue) {
      let players = 0;
      for (let i = 0; i < sessions.length; i++) {
        if ((sessions[i] as Session).state === SESSION_ACTIVE) players++;
      }
      this.statsPlayers = players;
    }
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i] as Session;
      if (s.state !== SESSION_ACTIVE) continue;
      this.sendSnapshot(s, t);
      // Still ACTIVE: transports deliver a close only from poll(), so a backpressure close during
      // the send arrives with the next tick's poll (its LEAVE then), and a closing transport drops
      // what is sent to it meanwhile.
      const box = s.events;
      if (box.count > 0 || this.statsDue) {
        const before = this.metrics.eventsSent;
        this.sendEvents(s.transport, box, this.statsDue);
        s.stats.eventsMessages += this.metrics.eventsSent - before;
        box.clear();
      }
    }
    if (this.recorder?.active === true) this.recordTick(this.recorder, t);
    this.currentTick = t;
    this.metrics.ticks++;
    this.tickEvents.clear();
  }

  /**
   * The host's tick times (D-043; µs, from its `TickHistogram`'s last 1 s window), which the next
   * SERVER_STATS events carry: each saturated to 0…65535 (a value that is not finite reads 0).
   * Called about once a second; the match itself never reads a clock.
   */
  reportTickStats(p50Us: number, p99Us: number, maxUs: number): void {
    const t = this.tickTimes;
    t[0] = saturateUs(p50Us);
    t[1] = saturateUs(p99Us);
    t[2] = saturateUs(maxUs);
  }

  /**
   * Sends the events of `box`, then SERVER_STATS when `stats`, to `target` as EVENTS messages of
   * at most 63 events each (D-043), in order. Allocates nothing.
   */
  sendEvents(target: EventsTarget, box: EventOutbox, stats: boolean): void {
    const m = this.eventsMsg;
    m.count = 0;
    const n = box.count;
    for (let i = 0; i < n; i++) {
      if (m.count === EVENTS_MAX_PER_MSG) this.sendEventsMsg(target);
      const kind = box.kind(i);
      const e = m.add(kind) as EventRecord;
      e.clientId = box.clientId(i);
      if (kind === EVK_PLAYER_JOIN) e.team = box.value(i);
      else e.reason = box.value(i);
    }
    if (stats) {
      if (m.count === EVENTS_MAX_PER_MSG) this.sendEventsMsg(target);
      const e = m.add(EVK_SERVER_STATS) as EventRecord;
      const t = this.tickTimes;
      e.tickP50Us = t[0] as number;
      e.tickP99Us = t[1] as number;
      e.tickMaxUs = t[2] as number;
      e.players = this.statsPlayers;
    }
    if (m.count > 0) this.sendEventsMsg(target);
  }

  private sendEventsMsg(target: EventsTarget): void {
    const w = this.writer;
    w.reset();
    if (encodeEvents(w, this.eventsMsg)) {
      target.sendReliable(w.bytes, w.byteLength);
      this.metrics.eventsSent++;
    } else {
      DEV_ASSERT(false, "EVENTS did not encode");
    }
    this.eventsMsg.count = 0;
  }

  // -------------------------------------------------------------------------------------------
  // Receiving

  /**
   * Adds `points` to the session's strike score (D-041): the first time it reaches `sv_strikeWarn`
   * the client gets a PRINT; at `sv_strikeKick` it is KICKed "too many bad packets" at once, so
   * nothing more it sent this poll is read.
   */
  private strike(s: Session, points: number): void {
    s.stats.strikes += points;
    this.metrics.strikes += points;
    const limits = this.limits;
    const crossed = s.strikeScore.add(points, limits.strikeWarn, limits.strikeKick);
    if (crossed === STRIKE_KICK) {
      this.kick(s, "too many bad packets");
    } else if (crossed === STRIKE_WARN) {
      this.sendPrint(s, PRINT_WARN, strikeWarning(s.strikeScore.score, limits.strikeKick));
    }
  }

  /**
   * Step 2's timeouts (D-041), by ticks so a stalled server never times anyone out: no HELLO
   * `helloTimeout` ticks after the connection opened, or not READY `handshakeTimeout` ticks after,
   * is "handshake timed out"; a welcomed or active session whose last message came `timeout` ticks
   * ago is "timed out".
   */
  private checkTimeouts(t: number): void {
    const limits = this.limits;
    const sessions = this.sessions;
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i] as Session;
      const state = s.state;
      if (state === SESSION_CLOSED) continue;
      const age = t - s.connectTick;
      if (state === SESSION_CONNECTING) {
        if (age >= limits.helloTimeout) this.kick(s, "handshake timed out");
      } else if (t - s.lastPacketTick >= limits.timeout) {
        this.kick(s, "timed out", EV_LEAVE_TIMED_OUT);
      } else if (state === SESSION_WELCOMED && age >= limits.handshakeTimeout) {
        this.kick(s, "handshake timed out");
      }
    }
  }

  private receive(s: Session, d: Uint8Array, len: number, reliable: boolean): void {
    if (s.state === SESSION_CLOSED) return;
    s.lastPacketTick = this.currentTick + 1;
    // Size first, then the channel's rate limit (M3 design §2.5 step 1): an oversized message is
    // struck even when its bucket is empty; a dropped one is never parsed. An empty one is the
    // WebSocket transport's marker for a frame past MAX_UNRELIABLE_BYTES (and no message anyway).
    if (!reliable && (len === 0 || len > MAX_UNRELIABLE_BYTES)) {
      this.strike(s, STRIKE_MALFORMED);
      return;
    }
    if (!(reliable ? s.reliableTokens : s.unreliableTokens).take()) {
      s.rateLimitedNow = true;
      s.stats.rateLimited++;
      this.metrics.rateLimited++;
      return;
    }
    const type = peekMessageType(d, len);
    const r = this.reader;
    r.reset(d, len);
    // Each message has its channel (docs/05 §3.3); one on the other channel is dropped and
    // struck as unexpected, like one the session's state has no use for; one that doesn't decode,
    // or isn't a client message at all, is struck as malformed.
    if (type === MSG_INPUT) {
      if (reliable) this.strike(s, STRIKE_UNEXPECTED);
      else if (!decodeInput(r, this.input)) this.strike(s, STRIKE_MALFORMED);
      else if (s.state !== SESSION_ACTIVE) this.strike(s, STRIKE_UNEXPECTED);
      else this.onInput(s);
    } else if (type === MSG_PING) {
      if (reliable) this.strike(s, STRIKE_UNEXPECTED);
      else if (!decodePing(r, this.ping)) this.strike(s, STRIKE_MALFORMED);
      else if (s.state === SESSION_CONNECTING) this.strike(s, STRIKE_UNEXPECTED);
      else this.sendPong(s);
    } else if (type !== MSG_HELLO && type !== MSG_READY && type !== MSG_CMD) {
      this.strike(s, STRIKE_MALFORMED);
    } else if (!reliable) {
      this.strike(s, STRIKE_UNEXPECTED);
    } else if (type === MSG_HELLO) {
      this.onHello(s, d, len);
    } else if (type === MSG_READY) {
      if (s.state !== SESSION_WELCOMED) this.strike(s, STRIKE_UNEXPECTED);
      else if (!decodeReady(r)) this.strike(s, STRIKE_MALFORMED);
      else this.join(s, this.currentTick + 1);
    } else if (s.state === SESSION_CONNECTING) {
      this.strike(s, STRIKE_UNEXPECTED);
    } else if (!decodeCmd(r, this.cmdMsg)) {
      this.strike(s, STRIKE_MALFORMED);
    } else {
      this.onCmd(s, this.cmdMsg.text);
    }
  }

  /**
   * INPUT: its ack to the session's baseline (D-038), its packet sequence to the input-loss count
   * (a forward step past 1 counts the packets between as lost; a reordered or repeated one counts
   * nothing), its cmds into the queue.
   */
  private onInput(s: Session): void {
    const m = this.input;
    if (acceptAck(s, m.lastSnapshotTick, this.currentTick + 1, this.history) === ACK_AHEAD) {
      this.strike(s, ACK_AHEAD_STRIKES);
      if (s.state === SESSION_CLOSED) return;
    }
    const st = s.stats;
    st.inputPackets++;
    this.metrics.inputPackets++;
    const seq = m.packetSeq;
    if (s.inputSeq < 0) {
      s.inputSeq = seq;
    } else {
      const step = (seq - s.inputSeq) & 0xffff;
      if (step > 0 && step < 0x8000) {
        st.inputLost += step - 1;
        this.metrics.inputLost += step - 1;
        s.inputSeq = seq;
      }
    }
    const q = s.queue;
    for (let i = 0; i < m.count; i++) q.push(m.cmds[i] as UserCmd);
  }

  private onHello(s: Session, d: Uint8Array, len: number): void {
    if (s.state !== SESSION_CONNECTING) {
      this.strike(s, STRIKE_UNEXPECTED);
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
      this.strike(s, STRIKE_MALFORMED);
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
    if (this.sessionEvents !== null) {
      this.sessionEvents("info", "welcome", { client: s.clientId, build: s.buildHash });
    }
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
    const rcon = parseRcon(text);
    if (rcon !== null) {
      this.onRcon(s, rcon.password, rcon.command);
      return;
    }
    this.reply(s, runServerCommand(text, this.cvars, s.admin, this));
  }

  /**
   * `rcon <password> <command…>` (D-042, M3 design §2.10): with rcon enabled and the sender's
   * address not locked out, a correct password runs the command as an admin of this match; a
   * wrong one costs STRIKE_RCON points and a PRINT. The password and the raw line are never
   * logged or echoed; the command's own reply and log lines (a kick's reason) are as without rcon.
   */
  private onRcon(s: Session, password: string, command: string): void {
    const check = this.rconCheck;
    if (check === null) {
      this.sendPrint(s, PRINT_ERROR, "rcon is disabled on this server");
      return;
    }
    if (password === "" || command === "") {
      this.sendPrint(s, PRINT_ERROR, "usage: rcon <command> (with rcon_password set)");
      return;
    }
    const gate = this.rconGate;
    if (gate !== null && !gate.allow(s.clientId)) {
      this.metrics.rconLocked++;
      this.sendPrint(s, PRINT_ERROR, "rcon: too many wrong passwords from your address; wait");
      return;
    }
    const ok = check(password);
    gate?.result(s.clientId, ok);
    if (!ok) {
      this.metrics.rconFailed++;
      this.sendPrint(s, PRINT_ERROR, "rcon: wrong password");
      this.strike(s, STRIKE_RCON);
      return;
    }
    this.metrics.rconOk++;
    this.reply(s, runServerCommand(command, this.cvars, true, this));
  }

  /** A command's reply: PRINTs of at most TEXT_MAX chars, split at line ends, then any resend. */
  private reply(s: Session, result: CommandResult): void {
    if (s.state === SESSION_CLOSED) return;
    const text = result.text;
    let from = 0;
    while (from < text.length) {
      let end = Math.min(text.length, from + TEXT_MAX);
      if (end < text.length) {
        const nl = text.lastIndexOf("\n", end);
        if (nl > from) end = nl;
      }
      this.sendPrint(s, result.level, text.slice(from, end));
      from = end < text.length && text.charCodeAt(end) === 0x0a ? end + 1 : end;
    }
    if (result.resendCvars) this.sendCvars(s);
  }

  /**
   * Runs one admin command on this match (the stdin console, and `@<match>` lines later): what a
   * client runs through rcon, the reply returned instead of sent.
   */
  runAdminCommand(text: string): CommandResult {
    return runServerCommand(text, this.cvars, true, this);
  }

  /** `status` (MatchAdmin): the map, tick and player count, then a line per session by id. */
  status(): string {
    const lines = [
      `${this.mapName}, tick ${this.currentTick}, ${this.sessions.length} of ${this.cap} players`,
    ];
    for (const s of this.sessions) {
      const team = s.state === SESSION_ACTIVE ? ` team ${s.team}` : "";
      lines.push(
        `#${s.clientId} ${STATE_NAMES[s.state] ?? "?"}${team} strikes ${s.strikeScore.score}` +
          `${s.admin ? " admin" : ""} build ${s.buildHash === "" ? "-" : s.buildHash}`,
      );
    }
    return lines.join("\n");
  }

  /** `kick <id> [reason]` (MatchAdmin). */
  kickClient(id: number, reason: string): boolean {
    const s = this.session(id);
    if (s === undefined || s.state === SESSION_CLOSED) return false;
    this.kick(s, reason);
    return true;
  }

  /** `metrics reset` (MatchAdmin): this match's run window, through its host. */
  metricsReset(): string | null {
    return this.onMetricsReset === null ? null : this.onMetricsReset();
  }

  /** The demo being recorded (its file), or null (D-044). */
  get recording(): string | null {
    const r = this.recorder;
    return r?.active ? r.file : null;
  }

  /** The recorder of the current or last demo, or null before the first (its counters). */
  get demoRecorder(): DemoRecorder | null {
    return this.recorder;
  }

  /**
   * `record [name]` (MatchAdmin, D-044): a name that is not a DEMO_NAME is refused; otherwise the
   * host opens the file (its default name for null) and the recording starts with the next
   * tick's end (the end of this tick when the command came in during one).
   */
  record(name: string | null): AdminReply {
    if (name !== null && !DEMO_NAME.test(name)) {
      return {
        ok: false,
        text: `record: "${name}" is not a demo name (1 to 64 of a-z, 0-9, _ and -)`,
      };
    }
    const current = this.recording;
    if (current !== null) return { ok: false, text: `record: already recording ${current}` };
    const host = this.demoHost;
    if (host === null) return { ok: false, text: "record: this server does not record demos" };
    // Checked before the file is opened: a header refused at the first tick would leave it empty.
    const why = demoHeaderProblem(this.mapName, this.buildHash);
    if (why !== null) return { ok: false, text: `record: ${why}` };
    const opened = host.open(name, this.mapName);
    if (typeof opened === "string") return { ok: false, text: `record: ${opened}` };
    this.startRecording(opened.sink, opened.file);
    return { ok: true, text: `recording ${opened.file}` };
  }

  /** `stoprecord` (MatchAdmin, D-044). */
  stopRecord(): AdminReply {
    const r = this.recorder;
    if (r === null || !r.active) return { ok: false, text: "stoprecord: not recording" };
    const file = this.stopRecording();
    return { ok: true, text: `stopped recording ${file} (${r.snapshots} ticks, ${r.bytes} B)` };
  }

  /**
   * Records this match into `sink` from the end of the next tick simulated (D-044); `file` names
   * it in replies. Ends a recording already running first. The recorder is made once per match.
   */
  startRecording(sink: DemoSink, file: string): void {
    if (this.recorder === null) this.recorder = new DemoRecorder();
    const r = this.recorder;
    if (r.active) this.stopRecording();
    r.start(
      sink,
      file,
      { name: this.mapName, hashLo: this.mapHashLo, hashHi: this.mapHashHi },
      this.buildHash,
    );
    this.log("info", `recording ${file} from tick ${this.currentTick + 1}`);
  }

  /** Ends the recording (its END record, then the sink's close); returns its file, "" if none. */
  stopRecording(): string {
    const r = this.recorder;
    if (r === null || !r.active) return "";
    // Stopped before its first tick: still a valid demo, a header and its END.
    if (r.startTick === 0) r.beginTick(this.currentTick + 1, this.block, this.blockEffectiveTick);
    const ticks = r.snapshots;
    const file = r.stop();
    this.log("info", `stopped recording ${file}: ${ticks} ticks, ${r.bytes} B`);
    return file;
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
    this.announceJoin(s);
    if (this.sessionEvents !== null) {
      this.sessionEvents("info", "ready", { client: s.clientId, tick: t, team: s.team });
    } else {
      this.log("info", `client ${s.clientId} spawned at tick ${t} on team ${s.team}`);
    }
  }

  /**
   * The roster for a player who just joined (D-043, M3 design §2.4): it gets a JOIN for every
   * player present, in id order, then its own, which tells its client the burst is over; every
   * other player gets its JOIN, as does the tick's broadcast record.
   */
  private announceJoin(s: Session): void {
    const sessions = this.sessions;
    const own = s.events;
    for (let i = 0; i < sessions.length; i++) {
      const o = sessions[i] as Session;
      if (o === s || o.state !== SESSION_ACTIVE) continue;
      own.push(EVK_PLAYER_JOIN, o.clientId, o.team);
      o.events.push(EVK_PLAYER_JOIN, s.clientId, s.team);
    }
    own.push(EVK_PLAYER_JOIN, s.clientId, s.team);
    this.tickEvents.push(EVK_PLAYER_JOIN, s.clientId, s.team);
  }

  /** A player who had joined left (`reason`: EV_LEAVE_*): every player still in it hears so. */
  private announceLeave(s: Session, reason: number): void {
    const sessions = this.sessions;
    for (let i = 0; i < sessions.length; i++) {
      const o = sessions[i] as Session;
      if (o !== s && o.state === SESSION_ACTIVE)
        o.events.push(EVK_PLAYER_LEAVE, s.clientId, reason);
    }
    this.tickEvents.push(EVK_PLAYER_LEAVE, s.clientId, reason);
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
    s.starvedRun = 0;
    const id = s.clientId;
    this.teleportSeqs[id] = ((this.teleportSeqs[id] as number) + 1) & 0xff;
  }

  private simulate(s: Session, t: number): void {
    const cmd = this.cmd;
    if (s.queue.take(t, cmd)) {
      s.stats.cmds++;
      s.starvedRun = 0;
    } else {
      // docs/05 §8.1 step 2: repeat the last cmd, but never a shot the client didn't send; and
      // once the client has been silent `sv_starveNeutralTicks` ticks (a hidden tab, a dead
      // client), not its move either: the player stands still instead of running on (D-041).
      copyUserCmd(cmd, s.lastCmd);
      if (s.starvedRun >= this.limits.starveNeutralTicks) {
        cmd.buttons = 0;
        cmd.forward = 0;
        cmd.right = 0;
        cmd.up = 0;
        this.metrics.neutralTicks++;
      } else {
        cmd.buttons &= ~BUTTON_ATTACK;
      }
      s.starvedRun++;
      cmd.tick = t;
      s.stats.starved++;
      s.snapFlags |= SNAP_FLAG_STARVED;
      // Every later snapshot carries the step, so losing this tick's hides no starve (D-050).
      s.starveSeq = (s.starveSeq + 1) & SNAP_STARVE_SEQ_MASK;
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
      if (s.state !== SESSION_CLOSED) {
        sessions[n++] = s;
      } else if (s.mirror !== null) {
        this.mirrors.release(s.mirror);
        s.mirror = null;
      }
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
   * The world frame of tick `t` into the history: every active player (stamp t), its serial, team,
   * teleport counter and event history.
   */
  private capture(t: number): void {
    const f = this.history.frameFor(t);
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
    this.history.stored(t);
  }

  /**
   * The snapshot of `t` for `s` (M3 design §2.3, D-038, D-046): a delta against the frame the
   * client holds for its acked tick while that is usable, else a full one, with the byte-budget
   * scheduler leaving players out when the worst case is past 1100 B (`buildSnapshot`). The tick
   * counts as sent (ackable, a future baseline) only once the encode succeeded; a failure sends
   * nothing and is counted as `snapshot_overflow`.
   */
  private sendSnapshot(s: Session, t: number): void {
    const h = this.snapHeader;
    h.flags = s.snapFlags;
    h.starveSeq = s.starveSeq;
    h.cvarHash = this.blockHash16;
    h.inputBufferHealth = Math.max(-128, Math.min(127, s.queue.newestTick - t));
    const w = this.writer;
    const sched = this.scheduler;
    const m = this.metrics;
    const ok = buildSnapshot(sched, w, h, this.history, s, s.clientId, t, this.mirrors);
    if (sched.sizePass) m.sizePasses++;
    if (sched.overrun) {
      m.schedOverrun++;
      this.log("warn", `client ${s.clientId}: sched_overrun at tick ${t}`);
      DEV_ASSERT(false, "sched_overrun", s.clientId);
    }
    if (!ok) {
      m.snapshotOverflow++;
      this.log("warn", `client ${s.clientId}: snapshot_overflow at tick ${t}`);
      DEV_ASSERT(false, "SNAPSHOT did not encode", s.clientId);
      return;
    }
    s.transport.sendUnreliable(w.bytes, w.byteLength);
    const st = s.stats;
    st.snapshots++;
    m.snapshots++;
    if (h.baseBack === 0) {
      st.fullSnapshots++;
      m.fullSnapshots++;
    }
    const left = sched.deferred + sched.dropped;
    if (left > 0) {
      st.deferredEntities += left;
      st.deferredSnapshots++;
      m.deferredEntities += left;
      m.deferredSnapshots++;
    }
    const stale = sched.maxStaleness;
    if (stale > st.maxStaleness) st.maxStaleness = stale;
    if (stale > m.maxStaleness) m.maxStaleness = stale;
  }

  /**
   * Step 8 (D-044): tick `t`'s demo records. The first tick's header carries the block; later
   * ticks carry a CVARS record when step 4 broadcast one. Then the spectator snapshot from the
   * world frame, then EVENTS: on the first tick a JOIN for every player present (so a demo knows
   * its whole roster, as a joiner's burst does), after it the tick's broadcast JOINs and LEAVEs;
   * SERVER_STATS with them on its ticks. The EVENTS counter counts only clients' messages.
   */
  private recordTick(r: DemoRecorder, t: number): void {
    const m = this.metrics;
    const records = r.records;
    const failed = r.failed;
    const first = r.beginTick(t, this.block, this.blockEffectiveTick);
    if (!r.active) {
      m.demoFailed += r.failed - failed;
      return;
    }
    if (!first && this.cvarsChanged && this.encodeCvarsMsg()) {
      r.write(DEMO_REC_CVARS, t, this.writer.bytes, this.writer.byteLength);
    }
    r.writeSnapshot(t, this.history, this.blockHash16);
    let box = this.tickEvents;
    if (first) {
      box = this.demoBurst;
      box.clear();
      const sessions = this.sessions;
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i] as Session;
        if (s.state === SESSION_ACTIVE) box.push(EVK_PLAYER_JOIN, s.clientId, s.team);
      }
    }
    if (box.count > 0 || this.statsDue) {
      const sent = m.eventsSent;
      this.sendEvents(r.events, box, this.statsDue);
      m.eventsSent = sent;
    }
    m.demoRecords += r.records - records;
    m.demoFailed += r.failed - failed;
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
    if (!this.encodeCvarsMsg()) return;
    s.transport.sendReliable(this.writer.bytes, this.writer.byteLength);
    this.metrics.cvarsSent++;
  }

  /** CVARS of the block simulated now and its effective tick, into the writer. */
  private encodeCvarsMsg(): boolean {
    const m = this.cvarsMsg;
    m.effectiveTick = this.blockEffectiveTick;
    m.block.entries.length = 0;
    for (const e of this.block.entries) m.block.entries.push(e);
    const w = this.writer;
    w.reset();
    if (!encodeCvars(w, m)) {
      DEV_ASSERT(false, "CVARS did not encode");
      return false;
    }
    return true;
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
