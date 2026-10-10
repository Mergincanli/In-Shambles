import {
  FRAME_SLOTS,
  PlayerState,
  SNAPSHOT_HISTORY,
  TEAM_NONE,
  type Transport,
  UserCmd,
} from "@game/shared";
import { InputQueue } from "./inputQueue";
import { StrikeScore, TokenBucket } from "./limits";
import type { ClientMirror } from "./mirror";
import type { SnapshotClient } from "./scheduler";

/** Waiting for HELLO. */
export const SESSION_CONNECTING = 0;
/** WELCOME sent: clock-sync PINGs and console CMDs are answered, READY spawns the player. */
export const SESSION_WELCOMED = 1;
/** Spawned: simulated every tick and sent a snapshot every tick. */
export const SESSION_ACTIVE = 2;
/** Kicked or disconnected: dropped from the match after this tick's poll. */
export const SESSION_CLOSED = 3;

/** Per-client counters (live). */
export class SessionStats {
  /** Ticks simulated with a repeated cmd because none had arrived (docs/05 §8.1 step 2). */
  starved = 0;
  /** Ticks simulated with the client's own cmd. */
  cmds = 0;
  /**
   * Strike points (D-041, weighted: 5 malformed, 2 unexpected, 1 per rate-limited tick), without
   * the decay `Session.strikeScore` applies; 0 for an honest client.
   */
  strikes = 0;
  /** Packets dropped because their channel's bucket was empty, and the ticks that dropped any. */
  rateLimited = 0;
  rateLimitedTicks = 0;
  /** INPUT packets received, and those missing from their `packetSeq` run (input loss, D-041). */
  inputPackets = 0;
  inputLost = 0;
  snapshots = 0;
  /** Snapshots sent without a baseline (the first, and whenever no usable ack was held; D-038). */
  fullSnapshots = 0;
  /** Players the byte-budget scheduler left out of its snapshots (D-046), and those snapshots. */
  deferredEntities = 0;
  deferredSnapshots = 0;
  /** The largest staleness of a remote at send (2 at most by D-046's bound; 1 without deferral). */
  maxStaleness = 0;
}

/**
 * One connected client (M2 design §1): its transport, handshake state, player, input queue,
 * counters and admin flag, what it was sent and acked (`SentState`, D-038), and the byte-budget
 * scheduler's rows and mirror (`SnapshotClient`, D-046). Fixed shape; everything per-tick is
 * preallocated here.
 */
export class Session implements SnapshotClient {
  state = SESSION_CONNECTING;
  readonly player = new PlayerState();
  readonly queue = new InputQueue();
  /** The cmd simulated last tick, repeated (attack cleared) when the next one is missing. */
  readonly lastCmd = new UserCmd();
  readonly stats = new SessionStats();
  /** The tick the player spawned on (−1 before READY). */
  spawnTick = -1;
  /** SNAP_FLAG_* bits for this tick's snapshot. */
  snapFlags = 0;
  /** The slot's connect counter when this client took it (u16, wrapping): the entity's serial. */
  serial = 0;
  /** TEAM_*: TEAM_NONE until READY assigns one (D-034; cosmetic until M7). */
  team = TEAM_NONE;
  /** The ticks of the last 64 snapshots sent, by `tick & 63` (0: none, or its encode failed). */
  readonly sentTicks = new Int32Array(SNAPSHOT_HISTORY);
  /** The newest snapshot tick sent, 0 before the first. */
  newestSent = 0;
  /** The newest valid tick the client acked: the next snapshot's baseline, 0 for a full one. */
  ackTick = 0;
  /** Per slot: the last tick a snapshot carried that player fresh (D-046). */
  readonly lastSent = new Int32Array(FRAME_SLOTS);
  /** Per slot: the last tick a snapshot left that player out (0: never). */
  readonly lastDeferred = new Int32Array(FRAME_SLOTS);
  /** Per slot: the serial of the player the last snapshot saw there (−1: none yet). */
  readonly sentSerial = new Int32Array(FRAME_SLOTS).fill(-1);
  /**
   * What it holds of each mirrored sent tick (D-046): only in a match that admits more than 37
   * players, from the match's pool; null otherwise (every frame plain).
   */
  mirror: ClientMirror | null = null;
  /** Unreliable and reliable rate limits (D-041), refilled at the start of every tick. */
  readonly unreliableTokens = new TokenBucket();
  readonly reliableTokens = new TokenBucket();
  /** The decaying strike score that warns and kicks (D-041). */
  readonly strikeScore = new StrikeScore();
  /** A bucket dropped a packet during this tick's poll (one strike point per such tick). */
  rateLimitedNow = false;
  /** The tick the session opened at (the match's serverTick then): the handshake timeouts' base. */
  connectTick = 0;
  /** The tick whose poll delivered the session's last message: the idle timeout's base. */
  lastPacketTick = 0;
  /** The newest INPUT `packetSeq` seen (−1 before the first), for the input-loss count. */
  inputSeq = -1;
  /**
   * Consecutive starved ticks (M3 design §2.5): from `sv_starveNeutralTicks` on, the repeated cmd
   * is a neutral one. A cmd that arrives in time, or a spawn, resets it.
   */
  starvedRun = 0;
  /** The client's nonce from HELLO. */
  nonce = 0;
  buildHash = "";

  constructor(
    readonly clientId: number,
    readonly transport: Transport,
    /** May change replicated cvars through CMD (D-027: the Worker's one client is admin). */
    readonly admin: boolean,
  ) {}
}
