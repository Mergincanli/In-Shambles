import type { CvarType, CvarValue } from "../../src/cvars/registry";
import { PITCH_LIMIT_U16 } from "../../src/math/angles";
import { BitReader, BitWriter } from "../../src/net/bitstream";
import type { CvarBlock, CvarBlockEntry } from "../../src/net/cvarBlock";
import {
  CmdMsg,
  CvarsMsg,
  decodeCmd,
  decodeCvars,
  decodeHello,
  decodeInput,
  decodeKick,
  decodePing,
  decodePong,
  decodePrint,
  decodeReady,
  decodeSnapshot,
  decodeWelcome,
  encodeCmd,
  encodeCvars,
  encodeHello,
  encodeInput,
  encodeKick,
  encodePing,
  encodePong,
  encodePrint,
  encodeReady,
  encodeSnapshot,
  encodeWelcome,
  HelloMsg,
  InputMsg,
  KickMsg,
  PingMsg,
  PongMsg,
  PrintMsg,
  SnapshotMsg,
  WelcomeMsg,
} from "../../src/net/messages";
import {
  MAX_RELIABLE_BYTES,
  MSG_CMD,
  MSG_CVARS,
  MSG_HELLO,
  MSG_INPUT,
  MSG_KICK,
  MSG_PING,
  MSG_PONG,
  MSG_PRINT,
  MSG_READY,
  MSG_SNAPSHOT,
  MSG_WELCOME,
} from "../../src/net/protocol";
import type { Mulberry32 } from "../../src/rng/mulberry32";
import type { PlayerState } from "../../src/sim/playerState";
import type { UserCmd } from "../../src/sim/usercmd";
import { TICK_MAX } from "../../src/time";

/** Seeded random values for the codec tests: edges a quarter of the time, uniform otherwise. */

function pick<T>(rng: Mulberry32, xs: readonly T[]): T {
  return xs[rng.nextInt(xs.length)] as T;
}

/** Uniform integer in [lo, hi], or one of the two ends a quarter of the time. */
export function intIn(rng: Mulberry32, lo: number, hi: number): number {
  const r = rng.nextInt(8);
  if (r === 0) return lo;
  if (r === 1) return hi;
  return lo + Math.floor(rng.nextFloat() * (hi - lo + 1));
}

export function tick(rng: Mulberry32): number {
  return intIn(rng, 0, TICK_MAX);
}

export function u32(rng: Mulberry32): number {
  return pick(rng, [0, 0xffffffff, rng.nextU32()]);
}

export function randomState(rng: Mulberry32, ps: PlayerState): PlayerState {
  for (let i = 0; i < 3; i++) ps.origin[i] = intIn(rng, -524288, 524288) / 32;
  for (let i = 0; i < 3; i++) ps.velocity[i] = intIn(rng, -524287, 524287) / 16;
  ps.viewYaw = intIn(rng, 0, 0xffff);
  ps.viewPitch = intIn(rng, -PITCH_LIMIT_U16, PITCH_LIMIT_U16) & 0xffff;
  ps.flags = intIn(rng, 0, 0x3ff);
  ps.groundEntity = intIn(rng, -1, 32767);
  ps.waterLevel = intIn(rng, 0, 3);
  ps.stamina = intIn(rng, 0, 0xffff);
  return ps;
}

export function randomCmdFields(rng: Mulberry32, c: UserCmd): void {
  c.buttons = intIn(rng, 0, 0xfff);
  c.forward = intIn(rng, -127, 127);
  c.right = intIn(rng, -127, 127);
  c.up = intIn(rng, -127, 127);
  c.yaw = intIn(rng, 0, 0xffff);
  c.pitch = intIn(rng, -PITCH_LIMIT_U16, PITCH_LIMIT_U16) & 0xffff;
  c.weaponSlot = intIn(rng, 0, 7);
}

const PRINTABLE =
  " !#%&()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_abcdefghijklmnopqrstuvwxyz{|}~";

export function ascii(rng: Mulberry32, maxLength: number): string {
  const n = intIn(rng, 0, maxLength);
  let s = "";
  for (let i = 0; i < n; i++) s += PRINTABLE[rng.nextInt(PRINTABLE.length)];
  return s;
}

const TEXT_EXTRA = "\t\näöüßé©ÿ ";

export function text(rng: Mulberry32, maxLength: number): string {
  const n = rng.nextInt(4) === 0 ? intIn(rng, 0, maxLength) : rng.nextInt(40);
  let s = "";
  for (let i = 0; i < n; i++) {
    s +=
      rng.nextInt(8) === 0
        ? TEXT_EXTRA[rng.nextInt(TEXT_EXTRA.length)]
        : PRINTABLE[rng.nextInt(PRINTABLE.length)];
  }
  return s;
}

const NAME_HEAD = "abcdefghijklmnopqrstuvwxyz";
const NAME_TAIL = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";

/** A finite, non-−0 double from random bits (any exponent), or an edge. */
const f64 = new DataView(new ArrayBuffer(8));
export function finiteDouble(rng: Mulberry32): number {
  if (rng.nextInt(4) === 0) {
    return pick(rng, [0, 1, -1, 0.1 + 0.2, Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE]);
  }
  for (;;) {
    f64.setUint32(0, rng.nextU32(), true);
    f64.setUint32(4, rng.nextU32(), true);
    const v = f64.getFloat64(0, true);
    if (Number.isFinite(v) && !Object.is(v, -0)) return v;
  }
}

export function randomValue(rng: Mulberry32, type: CvarType): CvarValue {
  switch (type) {
    case "int":
      return rng.nextU32() | 0;
    case "float":
      return finiteDouble(rng);
    case "bool":
      return rng.nextInt(2) === 1;
    case "string":
      return ascii(rng, rng.nextInt(4) === 0 ? 255 : 20);
  }
}

/** A canonical block of up to `max` entries with random names, kinds and values. */
export function randomBlock(rng: Mulberry32, out: CvarBlock, max = 24): CvarBlock {
  const n = rng.nextInt(max + 1);
  const names = new Map<string, string>();
  while (names.size < n) {
    let name = NAME_HEAD[rng.nextInt(NAME_HEAD.length)] as string;
    const len = rng.nextInt(16) === 0 ? 62 : rng.nextInt(20);
    for (let i = 0; i < len; i++) name += NAME_TAIL[rng.nextInt(NAME_TAIL.length)];
    if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  const sorted = [...names.keys()].sort();
  out.entries.length = 0;
  for (const key of sorted) {
    const type = pick<CvarType>(rng, ["int", "float", "bool", "string"]);
    const entry: CvarBlockEntry = {
      name: names.get(key) as string,
      type,
      value: randomValue(rng, type),
    };
    out.entries.push(entry);
  }
  return out;
}

/** Every message type, with a random message generator, its encoder and its decoder. */
export interface MessageKind {
  readonly type: number;
  readonly name: string;
  /** Fills a fresh struct with random valid fields and encodes it; returns the bytes. */
  random(rng: Mulberry32, w: BitWriter): Uint8Array;
  /** Decodes into a struct this kind keeps, and re-encodes it into `w` on success. */
  decodeAndReencode(r: BitReader, w: BitWriter): boolean;
  /** Decodes into the kept struct. */
  decode(r: BitReader): boolean;
}

function bytesOf(w: BitWriter): Uint8Array {
  if (w.error) throw new Error("random message failed to encode");
  return w.bytes.slice(0, w.byteLength);
}

function kind<T>(
  type: number,
  name: string,
  make: () => T,
  fill: (rng: Mulberry32, m: T) => void,
  encode: (w: BitWriter, m: T) => boolean,
  decode: (r: BitReader, m: T) => boolean,
): MessageKind {
  const kept = make();
  return {
    type,
    name,
    random(rng, w) {
      const m = make();
      fill(rng, m);
      w.reset();
      encode(w, m);
      return bytesOf(w);
    },
    decode(r) {
      return decode(r, kept);
    },
    decodeAndReencode(r, w) {
      if (!decode(r, kept)) return false;
      w.reset();
      return encode(w, kept);
    },
  };
}

export const MESSAGE_KINDS: readonly MessageKind[] = [
  kind(
    MSG_HELLO,
    "HELLO",
    () => new HelloMsg(),
    (rng, m) => {
      m.protocolVersion = intIn(rng, 0, 0xffff);
      m.buildHash = ascii(rng, 63);
      m.nonce = u32(rng);
    },
    encodeHello,
    decodeHello,
  ),
  kind(
    MSG_WELCOME,
    "WELCOME",
    () => new WelcomeMsg(),
    (rng, m) => {
      m.protocolVersion = intIn(rng, 0, 0xffff);
      m.clientId = intIn(rng, 0, 255);
      m.tickRate = intIn(rng, 1, 255);
      m.serverTick = tick(rng);
      m.mapName = ascii(rng, 63);
      m.mapHashLo = u32(rng);
      m.mapHashHi = u32(rng);
      randomBlock(rng, m.cvars);
    },
    encodeWelcome,
    decodeWelcome,
  ),
  kind(
    MSG_READY,
    "READY",
    () => null,
    () => {},
    (w) => encodeReady(w),
    (r) => decodeReady(r),
  ),
  kind(
    MSG_INPUT,
    "INPUT",
    () => new InputMsg(),
    (rng, m) => {
      m.packetSeq = intIn(rng, 0, 0xffff);
      m.lastSnapshotTick = tick(rng);
      m.count = intIn(rng, 1, 4);
      const newest = rng.nextInt(4) === 0 ? intIn(rng, 0, 300) : tick(rng);
      let back = 0;
      for (let i = 0; i < m.count; i++) {
        const c = m.cmds[i] as UserCmd;
        if (i > 0) {
          const room = Math.min(255, newest) - back - (m.count - 1 - i);
          if (room < 1) {
            m.count = i;
            break;
          }
          back += rng.nextInt(2) === 0 ? 1 : 1 + rng.nextInt(room);
        }
        c.tick = newest - back;
        randomCmdFields(rng, c);
      }
    },
    encodeInput,
    decodeInput,
  ),
  kind(
    MSG_SNAPSHOT,
    "SNAPSHOT",
    () => new SnapshotMsg(),
    (rng, m) => {
      m.serverTick = tick(rng);
      m.baselineTick = 0;
      m.lastProcessedCmdTick = tick(rng);
      m.inputBufferHealth = intIn(rng, -128, 127);
      m.cvarHash = intIn(rng, 0, 0xffff);
      m.flags = intIn(rng, 0, 3);
      randomState(rng, m.state);
    },
    encodeSnapshot,
    decodeSnapshot,
  ),
  kind(
    MSG_PING,
    "PING",
    () => new PingMsg(),
    (rng, m) => {
      m.pingId = intIn(rng, 0, 0xffff);
    },
    encodePing,
    decodePing,
  ),
  kind(
    MSG_PONG,
    "PONG",
    () => new PongMsg(),
    (rng, m) => {
      m.pingId = intIn(rng, 0, 0xffff);
      m.serverTick = tick(rng);
    },
    encodePong,
    decodePong,
  ),
  kind(
    MSG_CVARS,
    "CVARS",
    () => new CvarsMsg(),
    (rng, m) => {
      m.effectiveTick = tick(rng);
      randomBlock(rng, m.block);
    },
    encodeCvars,
    decodeCvars,
  ),
  kind(
    MSG_CMD,
    "CMD",
    () => new CmdMsg(),
    (rng, m) => {
      m.text = text(rng, 1023);
    },
    encodeCmd,
    decodeCmd,
  ),
  kind(
    MSG_PRINT,
    "PRINT",
    () => new PrintMsg(),
    (rng, m) => {
      m.level = intIn(rng, 0, 2);
      m.text = text(rng, 1023);
    },
    encodePrint,
    decodePrint,
  ),
  kind(
    MSG_KICK,
    "KICK",
    () => new KickMsg(),
    (rng, m) => {
      m.reason = text(rng, 1023);
    },
    encodeKick,
    decodeKick,
  ),
];

export function newWriter(): BitWriter {
  return new BitWriter(MAX_RELIABLE_BYTES);
}

export function readerOver(bytes: Uint8Array, length = bytes.length): BitReader {
  const r = new BitReader();
  r.reset(bytes, length);
  return r;
}
