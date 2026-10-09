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
  encodeWelcome,
  HelloMsg,
  InputMsg,
  KickMsg,
  PingMsg,
  PongMsg,
  PrintMsg,
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
  SNAP_BUDGET_BITS,
  SNAP_FLAG_SPECTATOR,
  SNAP_FLAG_STARVED,
  SNAPSHOT_HISTORY,
} from "../../src/net/protocol";
import {
  decodeSnapshotBody,
  decodeSnapshotHeader,
  ENTITY_NEW_BITS,
  encodeSnapshot,
  SNAP_FIT_MAX_PLAYERS,
  SNAP_FULL_FIXED_BITS,
  SnapshotHeader,
} from "../../src/net/snapshot";
import {
  copySlot,
  ENTITY_EVENT_SLOTS,
  FRAME_SLOTS,
  playerStateToSlot,
  WorldFrame,
} from "../../src/net/worldFrame";
import type { Mulberry32 } from "../../src/rng/mulberry32";
import { PMEV_JUMP, PMEV_LAND, PMEV_NONE } from "../../src/sim/events";
import { PlayerState } from "../../src/sim/playerState";
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

/**
 * The receiver of the random live snapshots the codec tests make: any id works, one in the middle
 * puts records on both sides of it.
 */
export const SNAP_SELF = 9;

/** The most other players a live full snapshot holds within SNAP_BUDGET_BITS (39). */
export const LIVE_FULL_MAX_OTHERS = Math.floor(
  (SNAP_BUDGET_BITS - SNAP_FULL_FIXED_BITS) / ENTITY_NEW_BITS,
);

const eventState = new PlayerState();

/** Random canonical event slots for slot `s` (kinds 0–3, empty slots last and zero, JUMP 0). */
function randomEvents(rng: Mulberry32, f: WorldFrame, s: number): void {
  const e = s * ENTITY_EVENT_SLOTS;
  const n = intIn(rng, 0, 2);
  for (let i = 0; i < ENTITY_EVENT_SLOTS; i++) {
    const kind = i < n ? intIn(rng, 1, PMEV_LAND) : PMEV_NONE;
    f.evKind[e + i] = kind;
    f.evValue[e + i] = kind === PMEV_NONE || kind === PMEV_JUMP ? 0 : intIn(rng, 0, 255);
  }
}

/** Random entity fields for slot `s` (present with `stamp`), every one within the record's range. */
export function randomEntity(rng: Mulberry32, f: WorldFrame, s: number, stamp: number): void {
  f.setPresent(s, stamp);
  f.serial[s] = intIn(rng, 0, 0xffff);
  f.originX[s] = intIn(rng, -524288, 524288);
  f.originY[s] = intIn(rng, -524288, 524288);
  f.originZ[s] = intIn(rng, -524288, 524288);
  f.entVelX[s] = intIn(rng, -32767, 32767);
  f.entVelY[s] = intIn(rng, -32767, 32767);
  f.entVelZ[s] = intIn(rng, -32767, 32767);
  f.yaw[s] = intIn(rng, 0, 0xffff);
  f.pitch[s] = intIn(rng, -PITCH_LIMIT_U16, PITCH_LIMIT_U16);
  f.flags[s] = intIn(rng, 0, 0x3ff);
  f.team[s] = intIn(rng, 0, 2);
  f.teleportSeq[s] = intIn(rng, 0, 255);
  f.eventSeq[s] = intIn(rng, 0, 255);
  randomEvents(rng, f, s);
}

/**
 * A random frame of tick `tick` for receiver `selfId` (−1: spectator): the receiver's slot with a
 * random quantized state and teleportSeq, and `others` other random present slots.
 */
export function randomFrame(
  rng: Mulberry32,
  f: WorldFrame,
  tick: number,
  selfId: number,
  others: number,
): WorldFrame {
  f.clear();
  if (selfId >= 0) {
    f.setPresent(selfId, tick);
    playerStateToSlot(f, selfId, randomState(rng, eventState));
    f.teleportSeq[selfId] = intIn(rng, 0, 255);
    f.team[selfId] = intIn(rng, 0, 2);
  }
  let left = others;
  // A random subset of the other slots, in a random order of picks.
  while (left > 0) {
    const s = rng.nextInt(FRAME_SLOTS);
    if (s === selfId || f.present[s] === 1) continue;
    randomEntity(rng, f, s, tick);
    left--;
  }
  return f;
}

const MAX_FIELD = 524288;
const MAX_LOCAL_VELOCITY = 524287;
const MAX_ENTITY_VELOCITY = 32767;

/**
 * `base` moved by a random class (M3 design §2.1): the same a quarter of the time, else a small
 * (i7), medium (i13) or any value, clamped to ±`max`, so every class and its edges come up.
 */
export function mutateAxis(rng: Mulberry32, base: number, max: number): number {
  const c = rng.nextInt(4);
  let v = base;
  if (c === 1) v = base + pick(rng, [-64, -1, 1, 63, intIn(rng, -64, 63)]);
  else if (c === 2) v = base + pick(rng, [-4096, -65, 64, 4095, intIn(rng, -4096, 4095)]);
  else if (c === 3) v = intIn(rng, -max, max);
  return Math.max(-max, Math.min(max, v));
}

/** Half the time `base`, else a random value of `lo`…`hi`. */
function maybe(rng: Mulberry32, base: number, lo: number, hi: number): number {
  return rng.nextInt(2) === 0 ? base : intIn(rng, lo, hi);
}

/**
 * Random changes to slot `s` of `f` (present, its entity fields): each field group alone or with
 * others, origin and velocity by random classes, everything within the record's range.
 */
export function mutateEntity(rng: Mulberry32, f: WorldFrame, s: number): void {
  const groups = rng.nextInt(4) === 0 ? 0xff : 1 << rng.nextInt(8);
  if ((groups & 1) !== 0) {
    f.originX[s] = mutateAxis(rng, f.originX[s] as number, MAX_FIELD);
    f.originY[s] = mutateAxis(rng, f.originY[s] as number, MAX_FIELD);
    f.originZ[s] = mutateAxis(rng, f.originZ[s] as number, MAX_FIELD);
  }
  if ((groups & 2) !== 0) {
    f.entVelX[s] = mutateAxis(rng, f.entVelX[s] as number, MAX_ENTITY_VELOCITY);
    f.entVelY[s] = mutateAxis(rng, f.entVelY[s] as number, MAX_ENTITY_VELOCITY);
    f.entVelZ[s] = mutateAxis(rng, f.entVelZ[s] as number, MAX_ENTITY_VELOCITY);
  }
  if ((groups & 4) !== 0) f.yaw[s] = intIn(rng, 0, 0xffff);
  if ((groups & 8) !== 0) f.pitch[s] = intIn(rng, -PITCH_LIMIT_U16, PITCH_LIMIT_U16);
  if ((groups & 16) !== 0) f.flags[s] = intIn(rng, 0, 0x3ff);
  if ((groups & 32) !== 0) f.team[s] = intIn(rng, 0, 2);
  if ((groups & 64) !== 0) f.teleportSeq[s] = intIn(rng, 0, 255);
  if ((groups & 128) !== 0) {
    f.eventSeq[s] = intIn(rng, 0, 255);
    randomEvents(rng, f, s);
  }
}

/** Random changes to the receiver's local-block fields of slot `s` of `f`. */
export function mutateLocal(rng: Mulberry32, f: WorldFrame, s: number): void {
  if (rng.nextInt(2) === 0) {
    f.originX[s] = mutateAxis(rng, f.originX[s] as number, MAX_FIELD);
    f.originY[s] = mutateAxis(rng, f.originY[s] as number, MAX_FIELD);
    f.originZ[s] = mutateAxis(rng, f.originZ[s] as number, MAX_FIELD);
  }
  if (rng.nextInt(2) === 0) {
    f.vel16X[s] = mutateAxis(rng, f.vel16X[s] as number, MAX_LOCAL_VELOCITY);
    f.vel16Y[s] = mutateAxis(rng, f.vel16Y[s] as number, MAX_LOCAL_VELOCITY);
    f.vel16Z[s] = mutateAxis(rng, f.vel16Z[s] as number, MAX_LOCAL_VELOCITY);
  }
  f.yaw[s] = maybe(rng, f.yaw[s] as number, 0, 0xffff);
  f.pitch[s] = maybe(rng, f.pitch[s] as number, -PITCH_LIMIT_U16, PITCH_LIMIT_U16);
  f.flags[s] = maybe(rng, f.flags[s] as number, 0, 0x3ff);
  f.ground1[s] = maybe(rng, f.ground1[s] as number, 0, 32768);
  f.waterLevel[s] = maybe(rng, f.waterLevel[s] as number, 0, 3);
  f.stamina[s] = maybe(rng, f.stamina[s] as number, 0, 0xffff);
}

/**
 * Frame `cur` of tick `tick` as a random successor of `base` (D-038): the receiver's slot (unless
 * spectator) with changed local fields and a random teleportSeq; each other slot `base` holds
 * left (a removal), replaced by a new incarnation (another serial), unchanged or changed; a few
 * slots `base` lacks appear. At most `maxRecords` slots need a record, so a live delta stays
 * within the budget by construction (36 records: the worst 1088 B).
 */
export function randomDeltaFrame(
  rng: Mulberry32,
  base: WorldFrame,
  cur: WorldFrame,
  tick: number,
  selfId: number,
  maxRecords: number,
): WorldFrame {
  cur.clear();
  if (selfId >= 0) {
    copySlot(cur, selfId, base, selfId);
    cur.setPresent(selfId, tick);
    mutateLocal(rng, cur, selfId);
    cur.teleportSeq[selfId] = maybe(rng, cur.teleportSeq[selfId] as number, 0, 255);
  }
  let records = 0;
  for (let s = 0; s < FRAME_SLOTS; s++) {
    if (s === selfId) continue;
    if (base.present[s] === 1) {
      const r = records < maxRecords ? rng.nextInt(10) : 4;
      if (r === 0) {
        records++;
        continue;
      }
      if (r === 1) {
        randomEntity(rng, cur, s, tick);
        cur.serial[s] = ((base.serial[s] as number) + 1 + rng.nextInt(1000)) & 0xffff;
        records++;
        continue;
      }
      copySlot(cur, s, base, s);
      cur.setPresent(s, tick);
      if (r >= 5) {
        mutateEntity(rng, cur, s);
        records++;
      }
    } else if (records < maxRecords && rng.nextInt(16) === 0) {
      randomEntity(rng, cur, s, tick);
      records++;
    }
  }
  return cur;
}

/** A snapshot header, frame and baseline frame, as the SNAPSHOT codec takes them. */
export class SnapshotParts {
  readonly hdr = new SnapshotHeader();
  readonly frame = new WorldFrame();
  /**
   * The baseline frame a delta (`hdr.baseBack` > 0) is coded against, as the receiver holds it.
   * Parts that encode and decode the same packet share it.
   */
  readonly base: WorldFrame;

  constructor(base: WorldFrame = new WorldFrame()) {
    this.base = base;
  }

  /** The receiver (−1 for a spectator snapshot). */
  get selfId(): number {
    return (this.hdr.flags & SNAP_FLAG_SPECTATOR) !== 0 ? -1 : SNAP_SELF;
  }

  /** The codec's `base` argument: null for a full snapshot. */
  get baseline(): WorldFrame | null {
    return this.hdr.baseBack === 0 ? null : this.base;
  }
}

export function encodeSnapshotParts(w: BitWriter, m: SnapshotParts): boolean {
  return encodeSnapshot(w, m.hdr, m.frame, m.baseline, m.selfId);
}

/** Header then body, as receiver SNAP_SELF (a spectator snapshot has none), against `m.base`. */
export function decodeSnapshotParts(r: BitReader, m: SnapshotParts): boolean {
  return (
    decodeSnapshotHeader(r, m.hdr) && decodeSnapshotBody(r, m.hdr, m.baseline, SNAP_SELF, m.frame)
  );
}

/**
 * Random valid parts: live (starved or not) or spectator, full or (half the time) a delta against
 * a random baseline in `m.base`, up to the most records that fit.
 */
export function randomSnapshot(rng: Mulberry32, m: SnapshotParts): SnapshotParts {
  const h = m.hdr;
  h.serverTick = intIn(rng, 1, TICK_MAX);
  const kind = rng.nextInt(5);
  h.flags = kind === 0 ? SNAP_FLAG_SPECTATOR : kind === 1 ? SNAP_FLAG_STARVED : 0;
  h.cvarHash = intIn(rng, 0, 0xffff);
  h.inputBufferHealth = intIn(rng, -128, 127);
  const spectator = kind === 0;
  const self = spectator ? -1 : SNAP_SELF;
  const max = spectator ? 24 : 16;
  const delta = h.serverTick > 1 && rng.nextInt(2) === 0;
  h.baseBack = delta ? intIn(rng, 1, Math.min(SNAPSHOT_HISTORY - 1, h.serverTick - 1)) : 0;
  if (!delta) {
    const others =
      rng.nextInt(10) === 0 ? (spectator ? 64 : LIVE_FULL_MAX_OTHERS) : intIn(rng, 0, max);
    randomFrame(rng, m.frame, h.serverTick, self, others);
    return m;
  }
  const most = spectator ? FRAME_SLOTS : SNAP_FIT_MAX_PLAYERS - 1;
  const baseOthers = rng.nextInt(10) === 0 ? most : intIn(rng, 0, max);
  randomFrame(rng, m.base, h.serverTick - h.baseBack, self, baseOthers);
  randomDeltaFrame(rng, m.base, m.frame, h.serverTick, self, rng.nextInt(10) === 0 ? most : max);
  return m;
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

/**
 * The baseline every SNAPSHOT kind struct shares: a random delta writes its baseline here, and the
 * kind's kept struct decodes the packet right after against the same frame.
 */
const fuzzBase = new WorldFrame();

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
    () => new SnapshotParts(fuzzBase),
    (rng, m) => {
      randomSnapshot(rng, m);
    },
    encodeSnapshotParts,
    decodeSnapshotParts,
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
