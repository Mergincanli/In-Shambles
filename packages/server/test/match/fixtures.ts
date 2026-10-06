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
  decodeSnapshot,
  decodeWelcome,
  encodeCmd,
  encodeHello,
  encodeInput,
  encodePing,
  encodeReady,
  HelloMsg,
  InputMsg,
  KickMsg,
  type LoopbackEndpoint,
  MAX_RELIABLE_BYTES,
  MSG_CVARS,
  MSG_KICK,
  MSG_PONG,
  MSG_PRINT,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  PingMsg,
  PongMsg,
  PrintMsg,
  peekMessageType,
  SnapshotMsg,
  type UserCmd,
  WelcomeMsg,
} from "@game/shared";

/** A committed greybox course, decoded with hash verification (content/maps). */
export function loadMap(name: string): Cmap {
  const path = fileURLToPath(new URL(`../../../../content/maps/${name}.cmap`, import.meta.url));
  return decodeCmap(new Uint8Array(readFileSync(path)));
}

export const TEST_BUILD = "test-build";

/**
 * A scripted client on one end of a loopback pair: encodes what a test sends and decodes, into
 * fresh copies, everything the match sends back.
 */
export class TestClient {
  readonly welcomes: WelcomeMsg[] = [];
  readonly snapshots: SnapshotMsg[] = [];
  readonly pongs: PongMsg[] = [];
  readonly cvars: CvarsMsg[] = [];
  readonly prints: PrintMsg[] = [];
  readonly kicks: KickMsg[] = [];
  /** Packets that did not decode (the match must never send one). */
  bad = 0;
  closed: string | null = null;
  private readonly w = new BitWriter(MAX_RELIABLE_BYTES);
  private readonly r = new BitReader();
  private packetSeq = 0;

  constructor(readonly transport: LoopbackEndpoint) {
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

  lastSnapshot(): SnapshotMsg {
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
      const m = new SnapshotMsg();
      ok = decodeSnapshot(r, m);
      if (ok) this.snapshots.push(m);
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
