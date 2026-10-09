import {
  BitReader,
  BitWriter,
  CmdMsg,
  CvarsMsg,
  copyUserCmd,
  decodeCvars,
  decodeKick,
  decodePong,
  decodePrint,
  decodeSnapshotHeader,
  decodeWelcome,
  encodeCmd,
  encodeHello,
  encodeInput,
  encodePing,
  encodeReady,
  HelloMsg,
  INPUT_MAX_CMDS,
  InputMsg,
  KickMsg,
  MATCH_MAX_CLIENTS,
  MAX_RELIABLE_BYTES,
  MSG_CVARS,
  MSG_KICK,
  MSG_PONG,
  MSG_PRINT,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  PingMsg,
  PongMsg,
  PROTOCOL_VERSION,
  PrintMsg,
  peekMessageType,
  SnapshotHeader,
  TICK_RATE,
  type Transport,
  type UserCmd,
  WelcomeMsg,
  type WorldFrame,
} from "@game/shared";
import type { ClientClock } from "./clock";
import type { CmdRing } from "./predictor";
import { SnapshotStore, STORE_NO_BASELINE, STORE_STALE, STORE_STORED } from "./snapshotStore";
import {
  type NetStats,
  STAT_BASELINE_DROPS,
  STAT_BYTES_IN,
  STAT_BYTES_OUT,
  STAT_DEFERRED,
  STAT_DEFERRED_SNAPSHOTS,
  STAT_FULL_SNAPSHOTS,
  STAT_PACKETS_OUT,
  STAT_STRIKES,
} from "./stats";

/** Not connected yet. */
export const CONN_IDLE = 0;
/** HELLO sent, waiting for WELCOME. */
export const CONN_CONNECTING = 1;
/** WELCOME taken: pinging for the clock handshake (docs/05 §2 step 3). */
export const CONN_SYNCING = 2;
/** READY sent, waiting for the first snapshot (the spawn). */
export const CONN_SPAWNING = 3;
/** Predicting and sending inputs. */
export const CONN_ACTIVE = 4;
/** Kicked, refused or closed; `closeReason` says why. */
export const CONN_CLOSED = 5;

/** What the connection hands up; `ClientSim` implements it. */
export interface ConnectionHandler {
  /** WELCOME arrived; returns a reason to disconnect, or null to go on. */
  onWelcome(m: WelcomeMsg): string | null;
  /** The map WELCOME named is loaded: READY may go (D-031). */
  mapReady(): boolean;
  /**
   * A SNAPSHOT that decoded and was stored, in CONN_SPAWNING or CONN_ACTIVE: its header and the
   * frame the store holds for its tick (both reused; read the local slot with slotToPlayerState).
   */
  onSnapshot(h: SnapshotHeader, frame: WorldFrame): void;
  /** A CVARS that decoded, from WELCOME on. `m` is reused. */
  onCvars(m: CvarsMsg): void;
  onPrint(level: number, text: string): void;
  /** The connection ended (kick, refusal or transport close). */
  onClosed(reason: string): void;
}

/**
 * The client's end of the protocol (docs/05 §2, §3.6; M2 design §1): the handshake state machine
 * (HELLO → WELCOME → clock-sync pings → READY → first snapshot), the decoding and channel check
 * of everything the server sends, and the encoding of what the client sends. Like the server, it
 * drops a packet that doesn't decode, arrives on the wrong channel or doesn't fit the state, and
 * counts a strike. Snapshots go into the `SnapshotStore` (protocol v2, D-033); a spectator one is
 * struck and dropped (demo files only, D-044). INPUT, SNAPSHOT, PING and PONG allocate nothing.
 */
export class Connection {
  state = CONN_IDLE;
  clientId = -1;
  closeReason = "";

  private readonly writer = new BitWriter(MAX_RELIABLE_BYTES);
  private readonly reader = new BitReader();
  private readonly hello = new HelloMsg();
  private readonly welcome = new WelcomeMsg();
  /** The frames received, by tick (M3 design §2.3). */
  readonly store = new SnapshotStore();
  /** A snapshot's header read outside CONN_SPAWNING/CONN_ACTIVE, to tell junk from a late one. */
  private readonly outOfState = new SnapshotHeader();
  private readonly ping = new PingMsg();
  private readonly pong = new PongMsg();
  private readonly cvars = new CvarsMsg();
  private readonly cmd = new CmdMsg();
  private readonly print = new PrintMsg();
  private readonly kick = new KickMsg();
  private readonly input = new InputMsg();
  private packetSeq = 0;

  constructor(
    readonly transport: Transport,
    private readonly clock: ClientClock,
    private readonly stats: NetStats,
    private readonly handler: ConnectionHandler,
    private readonly buildHash: string,
    private readonly nonce: number,
  ) {
    transport.onMessage((d, len, reliable) => this.receive(d, len, reliable));
    transport.onClose((reason) => this.closed(reason === "" ? "connection closed" : reason));
  }

  /** Sends HELLO. */
  connect(): void {
    if (this.state !== CONN_IDLE) return;
    const m = this.hello;
    m.protocolVersion = PROTOCOL_VERSION;
    m.buildHash = this.buildHash;
    m.nonce = this.nonce >>> 0;
    const w = this.writer;
    w.reset();
    if (!encodeHello(w, m)) {
      this.disconnect(`build ${this.buildHash} does not fit HELLO`);
      return;
    }
    this.sendReliable();
    this.state = CONN_CONNECTING;
  }

  /** Delivers what arrived (reconciliation runs inside, through the handler). */
  poll(): void {
    if (this.state !== CONN_IDLE && this.state !== CONN_CLOSED) this.transport.poll();
  }

  /**
   * Per frame, after `poll`: pings when due, and READY once the clock handshake is done and the
   * map WELCOME named is loaded (D-031), so the spawn never arrives before the world it is in.
   */
  update(): void {
    const s = this.state;
    if (s < CONN_SYNCING || s === CONN_CLOSED) return;
    if (this.clock.pingDue()) {
      this.ping.pingId = this.clock.nextPing();
      const w = this.writer;
      w.reset();
      if (encodePing(w, this.ping)) this.sendUnreliable();
    }
    if (s === CONN_SYNCING && this.clock.handshakeDone && this.handler.mapReady()) {
      const w = this.writer;
      w.reset();
      encodeReady(w);
      this.sendReliable();
      this.state = CONN_SPAWNING;
    }
  }

  /** The first snapshot arrived and the prediction started. */
  markActive(): void {
    if (this.state === CONN_SPAWNING) this.state = CONN_ACTIVE;
  }

  /**
   * INPUT with the newest cmds of `cmds` up to `newestTick`, newest first: up to four, as long as
   * the ticks run back without a gap (docs/05 §3.4 redundancy). It acks the store's `ackTick`: the
   * newest stored snapshot, the baseline the server codes the next deltas against (D-038).
   */
  sendInput(cmds: CmdRing, newestTick: number): void {
    const m = this.input;
    let n = 0;
    while (n < INPUT_MAX_CMDS) {
      const c = cmds.get(newestTick - n);
      if (c === null) break;
      copyUserCmd(m.cmds[n] as UserCmd, c);
      n++;
    }
    if (n === 0) return;
    m.count = n;
    m.packetSeq = this.packetSeq;
    this.packetSeq = (this.packetSeq + 1) & 0xffff;
    m.lastSnapshotTick = this.store.ackTick;
    const w = this.writer;
    w.reset();
    if (encodeInput(w, m)) this.sendUnreliable();
  }

  /** A console command for the server (CMD); false when it doesn't fit or there is no session. */
  sendCommand(text: string): boolean {
    if (this.state < CONN_SYNCING || this.state === CONN_CLOSED) return false;
    this.cmd.text = text;
    const w = this.writer;
    w.reset();
    if (!encodeCmd(w, this.cmd)) return false;
    this.sendReliable();
    return true;
  }

  /** Ends the session from this side. */
  disconnect(reason: string): void {
    if (this.state === CONN_CLOSED) return;
    this.transport.close(reason);
    this.closed(reason);
  }

  private closed(reason: string): void {
    if (this.state === CONN_CLOSED) return;
    this.state = CONN_CLOSED;
    this.closeReason = reason;
    this.handler.onClosed(reason);
  }

  private sendReliable(): void {
    const w = this.writer;
    this.transport.sendReliable(w.bytes, w.byteLength);
    this.stats.add(STAT_BYTES_OUT, w.byteLength);
    this.stats.add(STAT_PACKETS_OUT, 1);
  }

  private sendUnreliable(): void {
    const w = this.writer;
    this.transport.sendUnreliable(w.bytes, w.byteLength);
    this.stats.add(STAT_BYTES_OUT, w.byteLength);
    this.stats.add(STAT_PACKETS_OUT, 1);
  }

  private strike(): void {
    this.stats.add(STAT_STRIKES, 1);
  }

  private receive(d: Uint8Array, len: number, reliable: boolean): void {
    const state = this.state;
    if (state === CONN_CLOSED) return;
    this.stats.add(STAT_BYTES_IN, len);
    const type = peekMessageType(d, len);
    const r = this.reader;
    r.reset(d, len);
    // Each message has its channel (docs/05 §3.3); one on the other channel is dropped.
    if (type === MSG_SNAPSHOT) {
      if (reliable) {
        this.strike();
      } else if (state === CONN_SPAWNING || state === CONN_ACTIVE) {
        const store = this.store;
        const result = store.receive(r, this.clientId);
        if (result === STORE_STORED) {
          if (store.header.baseBack === 0) this.stats.add(STAT_FULL_SNAPSHOTS, 1);
          const deferred = store.header.deferred;
          if (deferred > 0) {
            this.stats.add(STAT_DEFERRED, deferred);
            this.stats.add(STAT_DEFERRED_SNAPSHOTS, 1);
          }
          this.handler.onSnapshot(store.header, store.lastStored as WorldFrame);
        } else if (result === STORE_NO_BASELINE) {
          this.stats.add(STAT_BASELINE_DROPS, 1);
        } else if (result !== STORE_STALE) {
          this.strike();
        }
      } else if (!decodeSnapshotHeader(r, this.outOfState)) {
        // Before the session (or after it) the body can't be read: its receiver isn't known.
        this.strike();
      }
    } else if (type === MSG_PONG) {
      if (reliable || !decodePong(r, this.pong)) this.strike();
      else if (state >= CONN_SYNCING) this.clock.onPong(this.pong.pingId);
    } else if (!reliable) {
      this.strike();
    } else if (type === MSG_WELCOME) {
      if (state !== CONN_CONNECTING || !decodeWelcome(r, this.welcome)) {
        this.strike();
        return;
      }
      this.onWelcome();
    } else if (type === MSG_CVARS) {
      if (state < CONN_SYNCING || !decodeCvars(r, this.cvars)) this.strike();
      else this.handler.onCvars(this.cvars);
    } else if (type === MSG_PRINT) {
      if (!decodePrint(r, this.print)) this.strike();
      else this.handler.onPrint(this.print.level, this.print.text);
    } else if (type === MSG_KICK) {
      if (!decodeKick(r, this.kick)) this.strike();
      else this.disconnect(`kicked: ${this.kick.reason}`);
    } else {
      this.strike();
    }
  }

  private onWelcome(): void {
    const m = this.welcome;
    if (m.protocolVersion !== PROTOCOL_VERSION) {
      this.disconnect(
        `server speaks protocol ${m.protocolVersion}, this client ${PROTOCOL_VERSION}`,
      );
      return;
    }
    if (m.tickRate !== TICK_RATE) {
      this.disconnect(`server ticks at ${m.tickRate} Hz, this client at ${TICK_RATE}`);
      return;
    }
    // Client id = slot = entity id (D-034): one past the slots could never be a snapshot's
    // receiver, so every snapshot would be struck and the session would never go live.
    if (m.clientId >= MATCH_MAX_CLIENTS) {
      this.disconnect(`server gave client id ${m.clientId} (max ${MATCH_MAX_CLIENTS - 1})`);
      return;
    }
    const refusal = this.handler.onWelcome(m);
    if (refusal !== null) {
      this.disconnect(refusal);
      return;
    }
    // The handler may have ended the session itself (a map refused from inside `onMapRequest`).
    if (this.state === CONN_CLOSED) return;
    this.clientId = m.clientId;
    this.state = CONN_SYNCING;
  }
}
