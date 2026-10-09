import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BitReader,
  BitWriter,
  type Cmap,
  CmdMsg,
  CvarsMsg,
  copyUserCmd,
  decodeCmap,
  decodeCvars,
  decodeKick,
  decodePong,
  decodePrint,
  decodeSnapshotBody,
  decodeSnapshotHeader,
  decodeWelcome,
  encodeCmd,
  encodeHello,
  encodeInput,
  encodePing,
  encodeReady,
  HelloMsg,
  InputMsg,
  KickMsg,
  MAX_RELIABLE_BYTES,
  MSG_CVARS,
  MSG_KICK,
  MSG_PONG,
  MSG_PRINT,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  PingMsg,
  PlayerState,
  PongMsg,
  PrintMsg,
  peekMessageType,
  SnapshotHeader,
  slotToPlayerState,
  type Transport,
  type UserCmd,
  WelcomeMsg,
  WorldFrame,
} from "@game/shared";

/** A committed greybox course, decoded with hash verification (content/maps). */
export function loadMap(name: string): Cmap {
  const path = fileURLToPath(new URL(`../../../../content/maps/${name}.cmap`, import.meta.url));
  return decodeCmap(new Uint8Array(readFileSync(path)));
}

export const TEST_BUILD = "test-build";

/** A decoded v2 snapshot (D-033) as the receiver holds it: the header, the frame, its own state. */
export class TestSnapshot {
  readonly header = new SnapshotHeader();
  readonly frame = new WorldFrame();
  /** The receiver's state, from its slot (the local block). */
  readonly state = new PlayerState();

  get serverTick(): number {
    return this.header.serverTick;
  }
  get flags(): number {
    return this.header.flags;
  }
  get inputBufferHealth(): number {
    return this.header.inputBufferHealth;
  }
  get cvarHash(): number {
    return this.header.cvarHash;
  }
  get teleportSeq(): number {
    return this.header.teleportSeq;
  }
  /** 0 for a full snapshot, else serverTick − the baseline's tick (D-038). */
  get baseBack(): number {
    return this.header.baseBack;
  }
  /** The ids of the other players the snapshot lists, ascending. */
  get entities(): number[] {
    const ids: number[] = [];
    for (let s = 0; s < this.frame.present.length; s++) {
      if (this.frame.present[s] === 1 && s !== this.clientId) ids.push(s);
    }
    return ids;
  }

  constructor(readonly clientId: number) {}
}

/**
 * A scripted client on any transport (one end of a loopback pair, or a real WebSocket in the Node
 * server tests): encodes what a test sends and decodes, into fresh copies, everything the match
 * sends back.
 */
export class TestClient {
  readonly welcomes: WelcomeMsg[] = [];
  readonly snapshots: TestSnapshot[] = [];
  readonly pongs: PongMsg[] = [];
  readonly cvars: CvarsMsg[] = [];
  readonly prints: PrintMsg[] = [];
  readonly kicks: KickMsg[] = [];
  /** Packets that did not decode (the match must never send one). */
  bad = 0;
  /** Deltas whose baseline this client never decoded (the match must never send one). */
  noBaseline = 0;
  closed: string | null = null;
  private readonly w = new BitWriter(MAX_RELIABLE_BYTES);
  private readonly r = new BitReader();
  private packetSeq = 0;

  constructor(readonly transport: Transport) {
    transport.onMessage((d, len) => this.receive(d, len));
    transport.onClose((reason) => {
      this.closed = reason;
    });
  }

  hello(buildHash = TEST_BUILD, protocolVersion?: number): void {
    const m = new HelloMsg();
    m.buildHash = buildHash;
    m.nonce = 0x1234;
    if (protocolVersion !== undefined) m.protocolVersion = protocolVersion;
    this.w.reset();
    encodeHello(this.w, m);
    this.transport.sendReliable(this.w.bytes, this.w.byteLength);
  }

  ready(): void {
    this.w.reset();
    encodeReady(this.w);
    this.transport.sendReliable(this.w.bytes, this.w.byteLength);
  }

  /** One INPUT with `cmds`, newest first (1–4). */
  input(cmds: readonly UserCmd[], lastSnapshotTick = 0): void {
    const m = new InputMsg();
    m.packetSeq = this.packetSeq++ & 0xffff;
    m.lastSnapshotTick = lastSnapshotTick;
    m.count = cmds.length;
    for (let i = 0; i < cmds.length; i++) copyUserCmd(m.cmds[i] as UserCmd, cmds[i] as UserCmd);
    this.w.reset();
    if (!encodeInput(this.w, m)) throw new Error("test INPUT did not encode");
    this.transport.sendUnreliable(this.w.bytes, this.w.byteLength);
  }

  ping(id: number): void {
    const m = new PingMsg();
    m.pingId = id;
    this.w.reset();
    encodePing(this.w, m);
    this.transport.sendUnreliable(this.w.bytes, this.w.byteLength);
  }

  cmd(text: string): void {
    const m = new CmdMsg();
    m.text = text;
    this.w.reset();
    encodeCmd(this.w, m);
    this.transport.sendReliable(this.w.bytes, this.w.byteLength);
  }

  raw(bytes: Uint8Array, reliable: boolean): void {
    if (reliable) this.transport.sendReliable(bytes, bytes.length);
    else this.transport.sendUnreliable(bytes, bytes.length);
  }

  poll(): void {
    this.transport.poll();
  }

  lastSnapshot(): TestSnapshot {
    const s = this.snapshots.at(-1);
    if (s === undefined) throw new Error("no snapshot yet");
    return s;
  }

  private receive(d: Uint8Array, len: number): void {
    const r = this.r;
    r.reset(d, len);
    const type = peekMessageType(d, len);
    let ok = false;
    if (type === MSG_WELCOME) {
      const m = new WelcomeMsg();
      ok = decodeWelcome(r, m);
      if (ok) this.welcomes.push(m);
    } else if (type === MSG_SNAPSHOT) {
      // Decoded as the client WELCOME named (none yet: refused as bad); a delta against the
      // frame this client decoded for its baseline tick (D-038).
      const id = this.welcomes.at(-1)?.clientId ?? -1;
      const m = new TestSnapshot(id);
      ok = decodeSnapshotHeader(r, m.header);
      let base: WorldFrame | null = null;
      if (ok && m.header.baseBack !== 0) {
        const tick = m.header.serverTick - m.header.baseBack;
        base = this.snapshots.findLast((x) => x.serverTick === tick)?.frame ?? null;
        if (base === null) {
          this.noBaseline++;
          return;
        }
      }
      ok = ok && decodeSnapshotBody(r, m.header, base, id, m.frame);
      if (ok) {
        slotToPlayerState(m.frame, id, m.state);
        this.snapshots.push(m);
      }
    } else if (type === MSG_PONG) {
      const m = new PongMsg();
      ok = decodePong(r, m);
      if (ok) this.pongs.push(m);
    } else if (type === MSG_CVARS) {
      const m = new CvarsMsg();
      ok = decodeCvars(r, m);
      if (ok) this.cvars.push(m);
    } else if (type === MSG_PRINT) {
      const m = new PrintMsg();
      ok = decodePrint(r, m);
      if (ok) this.prints.push(m);
    } else if (type === MSG_KICK) {
      const m = new KickMsg();
      ok = decodeKick(r, m);
      if (ok) this.kicks.push(m);
    }
    if (!ok) this.bad++;
  }
}
