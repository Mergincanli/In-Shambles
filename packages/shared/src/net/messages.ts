import { PITCH_LIMIT_U16 } from "../math/angles";
import { toSigned16 } from "../math/quant";
import { BUTTON_MASK, MOVE_AXIS_MAX, UserCmd, WEAPON_SLOT_COUNT } from "../sim/usercmd";
import { TICK_MAX, TICK_RATE } from "../time";
import {
  type BitReader,
  type BitWriter,
  readAscii,
  readText,
  writeAscii,
  writeText,
} from "./bitstream";
import { CvarBlock, cvarBlockHash, decodeCvarBlock, encodeCvarBlock } from "./cvarBlock";
import {
  INPUT_MAX_CMDS,
  INPUT_TICK_BACK_MAX,
  MSG_CMD,
  MSG_CVARS,
  MSG_HELLO,
  MSG_INPUT,
  MSG_KICK,
  MSG_PING,
  MSG_PONG,
  MSG_PRINT,
  MSG_READY,
  MSG_WELCOME,
  PRINT_ERROR,
  PROTOCOL_VERSION,
  SHORT_TEXT_MAX,
  TEXT_MAX,
} from "./protocol";

/**
 * Protocol messages (docs/05 §3.6, D-026; SNAPSHOT lives in snapshot.ts, D-033): one fixed-shape
 * struct per message and a codec pair. The caller resets the writer, encodes one message and sends `w.byteLength` bytes; the
 * receiver resets a reader over the packet, switches on `peekMessageType` and decodes into a
 * struct it keeps.
 *
 * - `encodeX(w, msg)` returns false (the writer's error flag) when a field is out of the range its
 *   layout carries or the buffer is full: a sender bug, so the message is not sent.
 * - `decodeX(r, out)` returns false on a short read, a wrong type byte, any value the encoder
 *   never writes (pitch past ±16201, a tick past TICK_MAX, an INPUT count outside 1–4…) or bits
 *   left after the message's last byte. The caller
 *   drops the packet and counts a strike; `out` is then partial. Decoders never throw.
 *
 * INPUT, PING and PONG encode and decode without allocating, rejected packets
 * included: ticks are read through `readTick`, so a hostile u32 never becomes a heap number. The
 * text and cvar-block fields of the reliable setup messages allocate (rare).
 */

/** The type byte of a packet, or 0 (no message type) for an empty one. */
export function peekMessageType(bytes: Uint8Array, length: number): number {
  return length >= 1 && bytes.length >= 1 ? (bytes[0] as number) : 0;
}

/** A tick in 32 bits; past TICK_MAX (or not a u32) sets the writer's error flag. */
export function writeTick(w: BitWriter, tick: number): void {
  if (tick > TICK_MAX) w.fail();
  w.writeBits(tick, 32);
}

/** TICK_MAX's high 16 bits: a tick's high half above this puts it past TICK_MAX. */
const TICK_HI_MAX = TICK_MAX >>> 16;

/**
 * A 32-bit tick, or −1 when it is past TICK_MAX (or the read is short: then 0 with the reader's
 * error set). The same bits as `readBits(32)`, read as two u16 halves: a u32 past 2^30 − 1 is no
 * small integer (V8's are 31 bits under pointer compression), so returning one from a reader
 * call V8 doesn't inline, or storing it, would allocate a heap number for every hostile packet.
 */
export function readTick(r: BitReader): number {
  const lo = r.readBits(16);
  const hi = r.readBits(16);
  if (hi > TICK_HI_MAX) return -1;
  return lo + hi * 0x10000;
}

function cmdInRange(c: UserCmd): boolean {
  const p = toSigned16(c.pitch);
  return (
    (c.buttons & ~BUTTON_MASK) === 0 &&
    c.forward >= -MOVE_AXIS_MAX &&
    c.forward <= MOVE_AXIS_MAX &&
    c.right >= -MOVE_AXIS_MAX &&
    c.right <= MOVE_AXIS_MAX &&
    c.up >= -MOVE_AXIS_MAX &&
    c.up <= MOVE_AXIS_MAX &&
    p >= -PITCH_LIMIT_U16 &&
    p <= PITCH_LIMIT_U16 &&
    c.weaponSlot >= 0 &&
    c.weaponSlot < WEAPON_SLOT_COUNT
  );
}

// ---------------------------------------------------------------------------------------------
// HELLO C→S (reliable): protocolVersion u16, buildHash (u6 length + 7-bit ASCII), nonce u32.

export class HelloMsg {
  protocolVersion = PROTOCOL_VERSION;
  buildHash = "";
  nonce = 0;
}

export function encodeHello(w: BitWriter, m: HelloMsg): boolean {
  w.writeBits(MSG_HELLO, 8);
  w.writeBits(m.protocolVersion, 16);
  writeAscii(w, m.buildHash, 6, SHORT_TEXT_MAX);
  w.writeBits(m.nonce, 32);
  return !w.error;
}

/**
 * The protocolVersion of a HELLO packet, or −1 when it isn't one or is shorter than 3 B. The
 * first 3 B of HELLO (type u8, protocolVersion u16) are frozen across protocol versions (docs/05
 * §3.6), so the server reads a client's version before it parses anything else and answers a
 * mismatch with a clear KICK, whatever layout the rest of a newer HELLO has.
 */
export function peekHelloVersion(bytes: Uint8Array, length: number): number {
  if (length < 3 || bytes.length < 3 || bytes[0] !== MSG_HELLO) return -1;
  return (bytes[1] as number) | ((bytes[2] as number) << 8);
}

/** The v1 layout; any protocolVersion is kept (the server checks it with peekHelloVersion). */
export function decodeHello(r: BitReader, out: HelloMsg): boolean {
  if (r.readBits(8) !== MSG_HELLO) return false;
  out.protocolVersion = r.readBits(16);
  const build = readAscii(r, 6, SHORT_TEXT_MAX);
  if (build === null) return false;
  out.buildHash = build;
  out.nonce = r.readBits(32);
  return r.atEnd();
}

// ---------------------------------------------------------------------------------------------
// WELCOME S→C (reliable): protocolVersion u16, clientId u8, tickRate u8 (1–255), serverTick u32,
// mapName (u6 + 7-bit ASCII), mapHash lo u32 + hi u32 (the cmap contentHash), cvar block.

export class WelcomeMsg {
  protocolVersion = PROTOCOL_VERSION;
  clientId = 0;
  tickRate = TICK_RATE;
  serverTick = 0;
  mapName = "";
  mapHashLo = 0;
  mapHashHi = 0;
  readonly cvars = new CvarBlock();
}

export function encodeWelcome(w: BitWriter, m: WelcomeMsg): boolean {
  w.writeBits(MSG_WELCOME, 8);
  w.writeBits(m.protocolVersion, 16);
  w.writeBits(m.clientId, 8);
  if (m.tickRate === 0) w.fail();
  w.writeBits(m.tickRate, 8);
  writeTick(w, m.serverTick);
  writeAscii(w, m.mapName, 6, SHORT_TEXT_MAX);
  w.writeBits(m.mapHashLo, 32);
  w.writeBits(m.mapHashHi, 32);
  encodeCvarBlock(w, m.cvars);
  return !w.error;
}

export function decodeWelcome(r: BitReader, out: WelcomeMsg): boolean {
  if (r.readBits(8) !== MSG_WELCOME) return false;
  out.protocolVersion = r.readBits(16);
  out.clientId = r.readBits(8);
  const tickRate = r.readBits(8);
  const serverTick = readTick(r);
  if (tickRate === 0 || serverTick < 0) return false;
  out.tickRate = tickRate;
  out.serverTick = serverTick;
  const map = readAscii(r, 6, SHORT_TEXT_MAX);
  if (map === null) return false;
  out.mapName = map;
  out.mapHashLo = r.readBits(32);
  out.mapHashHi = r.readBits(32);
  if (!decodeCvarBlock(r, out.cvars)) return false;
  return r.atEnd();
}

// ---------------------------------------------------------------------------------------------
// READY C→S (reliable): the type byte only.

export function encodeReady(w: BitWriter): boolean {
  w.writeBits(MSG_READY, 8);
  return !w.error;
}

export function decodeReady(r: BitReader): boolean {
  return r.readBits(8) === MSG_READY && r.atEnd();
}

// ---------------------------------------------------------------------------------------------
// INPUT C→S (unreliable): packetSeq u16, lastSnapshotTick u32, count u3 (1–4), newestTick u32,
// then per cmd, newest first: tickBack u8 (newestTick − tick; 1–255, rising; not written for the
// first cmd, whose tick is newestTick), buttons u16, forward/right/up i8, yaw u16, pitch u16,
// weaponSlot u8. Four cmds: 435 bits, 55 B (3.3 KB/s at 60 Hz).

export class InputMsg {
  packetSeq = 0;
  /** The newest snapshot tick the client holds: the ack for delta baselines (docs/05 §3.4). */
  lastSnapshotTick = 0;
  /** Cmds in use, 1–4. */
  count = 0;
  /** Newest first; cmds[0].tick is the packet's newestTick. */
  readonly cmds: readonly UserCmd[] = [new UserCmd(), new UserCmd(), new UserCmd(), new UserCmd()];
}

export function encodeInput(w: BitWriter, m: InputMsg): boolean {
  const n = m.count;
  if (n < 1 || n > INPUT_MAX_CMDS) {
    w.fail();
    return false;
  }
  const cmds = m.cmds;
  const newest = (cmds[0] as UserCmd).tick;
  w.writeBits(MSG_INPUT, 8);
  w.writeBits(m.packetSeq, 16);
  writeTick(w, m.lastSnapshotTick);
  w.writeBits(n, 3);
  writeTick(w, newest);
  let prevBack = 0;
  for (let i = 0; i < n; i++) {
    const c = cmds[i] as UserCmd;
    if (i > 0) {
      const back = newest - c.tick;
      if (back <= prevBack || back > INPUT_TICK_BACK_MAX || back > newest) w.fail();
      w.writeBits(back, 8);
      prevBack = back;
    }
    if (!cmdInRange(c)) w.fail();
    w.writeBits(c.buttons, 16);
    w.writeSigned(c.forward, 8);
    w.writeSigned(c.right, 8);
    w.writeSigned(c.up, 8);
    w.writeBits(c.yaw, 16);
    w.writeBits(c.pitch, 16);
    w.writeBits(c.weaponSlot, 8);
  }
  return !w.error;
}

/**
 * Decoded cmds are in the ranges sanitizeUserCmd forces (the server still sanitizes them), with
 * distinct ticks falling from cmds[0], none below 0.
 */
export function decodeInput(r: BitReader, out: InputMsg): boolean {
  if (r.readBits(8) !== MSG_INPUT) return false;
  out.packetSeq = r.readBits(16);
  const lastSnapshotTick = readTick(r);
  const n = r.readBits(3);
  const newest = readTick(r);
  if (lastSnapshotTick < 0 || newest < 0 || n < 1 || n > INPUT_MAX_CMDS) {
    return false;
  }
  out.lastSnapshotTick = lastSnapshotTick;
  out.count = n;
  const cmds = out.cmds;
  let prevBack = 0;
  for (let i = 0; i < n; i++) {
    const c = cmds[i] as UserCmd;
    let back = 0;
    if (i > 0) {
      back = r.readBits(8);
      if (back <= prevBack || back > newest) return false;
      prevBack = back;
    }
    c.tick = newest - back;
    c.buttons = r.readBits(16);
    c.forward = r.readSigned(8);
    c.right = r.readSigned(8);
    c.up = r.readSigned(8);
    c.yaw = r.readBits(16);
    c.pitch = r.readBits(16);
    c.weaponSlot = r.readBits(8);
    if (!cmdInRange(c)) return false;
  }
  return r.atEnd();
}

// ---------------------------------------------------------------------------------------------
// PING C→S (unreliable): pingId u16. PONG S→C (unreliable): pingId u16, serverTick u32.

export class PingMsg {
  pingId = 0;
}

export class PongMsg {
  pingId = 0;
  serverTick = 0;
}

export function encodePing(w: BitWriter, m: PingMsg): boolean {
  w.writeBits(MSG_PING, 8);
  w.writeBits(m.pingId, 16);
  return !w.error;
}

export function decodePing(r: BitReader, out: PingMsg): boolean {
  if (r.readBits(8) !== MSG_PING) return false;
  out.pingId = r.readBits(16);
  return r.atEnd();
}

export function encodePong(w: BitWriter, m: PongMsg): boolean {
  w.writeBits(MSG_PONG, 8);
  w.writeBits(m.pingId, 16);
  writeTick(w, m.serverTick);
  return !w.error;
}

export function decodePong(r: BitReader, out: PongMsg): boolean {
  if (r.readBits(8) !== MSG_PONG) return false;
  out.pingId = r.readBits(16);
  const serverTick = readTick(r);
  if (serverTick < 0) return false;
  out.serverTick = serverTick;
  return r.atEnd();
}

// ---------------------------------------------------------------------------------------------
// CVARS S→C (reliable): effectiveTick u32, blockHash u32, cvar block. The client switches its
// prediction parameters at effectiveTick (D-027).

export class CvarsMsg {
  effectiveTick = 0;
  /** cvarBlockHash(block); the encoder writes it, the decoder checks it. */
  blockHash = 0;
  readonly block = new CvarBlock();
}

/** Writes the block's own hash; `m.blockHash` is set to it. */
export function encodeCvars(w: BitWriter, m: CvarsMsg): boolean {
  const hash = cvarBlockHash(m.block);
  if (hash < 0) {
    w.fail();
    return false;
  }
  m.blockHash = hash;
  w.writeBits(MSG_CVARS, 8);
  writeTick(w, m.effectiveTick);
  w.writeBits(hash, 32);
  encodeCvarBlock(w, m.block);
  return !w.error;
}

/** Also false when blockHash is not the hash of the block that follows it. */
export function decodeCvars(r: BitReader, out: CvarsMsg): boolean {
  if (r.readBits(8) !== MSG_CVARS) return false;
  const effectiveTick = readTick(r);
  out.blockHash = r.readBits(32);
  if (effectiveTick < 0) return false;
  out.effectiveTick = effectiveTick;
  if (!decodeCvarBlock(r, out.block) || !r.atEnd()) return false;
  return cvarBlockHash(out.block) === out.blockHash;
}

// ---------------------------------------------------------------------------------------------
// CMD C→S, PRINT S→C, KICK S→C (reliable): console text as a u10 length + 8-bit Latin-1 chars
// (no control chars but tab and newline); PRINT has a u2 level (PRINT_INFO/WARN/ERROR) first.

export class CmdMsg {
  text = "";
}

export class PrintMsg {
  level = 0;
  text = "";
}

export class KickMsg {
  reason = "";
}

export function encodeCmd(w: BitWriter, m: CmdMsg): boolean {
  w.writeBits(MSG_CMD, 8);
  writeText(w, m.text, 10, TEXT_MAX);
  return !w.error;
}

export function decodeCmd(r: BitReader, out: CmdMsg): boolean {
  if (r.readBits(8) !== MSG_CMD) return false;
  const text = readText(r, 10, TEXT_MAX);
  if (text === null) return false;
  out.text = text;
  return r.atEnd();
}

export function encodePrint(w: BitWriter, m: PrintMsg): boolean {
  w.writeBits(MSG_PRINT, 8);
  if (m.level > PRINT_ERROR) w.fail();
  w.writeBits(m.level, 2);
  writeText(w, m.text, 10, TEXT_MAX);
  return !w.error;
}

export function decodePrint(r: BitReader, out: PrintMsg): boolean {
  if (r.readBits(8) !== MSG_PRINT) return false;
  out.level = r.readBits(2);
  if (out.level > PRINT_ERROR) return false;
  const text = readText(r, 10, TEXT_MAX);
  if (text === null) return false;
  out.text = text;
  return r.atEnd();
}

export function encodeKick(w: BitWriter, m: KickMsg): boolean {
  w.writeBits(MSG_KICK, 8);
  writeText(w, m.reason, 10, TEXT_MAX);
  return !w.error;
}

export function decodeKick(r: BitReader, out: KickMsg): boolean {
  if (r.readBits(8) !== MSG_KICK) return false;
  const reason = readText(r, 10, TEXT_MAX);
  if (reason === null) return false;
  out.reason = reason;
  return r.atEnd();
}
