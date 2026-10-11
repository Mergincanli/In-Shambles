import { TICK_MAX, TICK_RATE } from "../time";
import { BitReader, BitWriter } from "./bitstream";
import { decodeEvents, EventsMsg } from "./events";
import { CvarsMsg, decodeCvars, encodeCvars } from "./messages";
import {
  MAX_RELIABLE_BYTES,
  MAX_SPECTATOR_SNAPSHOT_BYTES,
  MSG_CVARS,
  MSG_EVENTS,
  MSG_SNAPSHOT,
  PROTOCOL_VERSION,
  SHORT_TEXT_MAX,
  SNAP_FLAG_SPECTATOR,
} from "./protocol";
import { decodeSnapshotBody, decodeSnapshotHeader, SnapshotHeader } from "./snapshot";
import { FRAME_SLOTS, FrameRing, WorldFrame } from "./worldFrame";

/**
 * The `.demo` file (D-044, M3 design §2.12): what the server's spectator recorder writes and
 * playback, `pnpm demo-info` and the tests read. Byte-aligned, little-endian:
 *
 * | Field | Bytes |
 * |---|---|
 * | magic "ISDM" | 4 |
 * | demoVersion | u16 (DEMO_VERSION) |
 * | protocolVersion | u16 (the SNAPSHOT, EVENTS and CVARS layouts of the records) |
 * | tickRate | u8 |
 * | startTick | u32: the first tick recorded |
 * | mapName | u8 length + ASCII |
 * | mapHash | lo u32, hi u32 (the cmap contentHash's two lanes, as WELCOME carries them) |
 * | buildHash | u8 length + ASCII |
 * | cvar block | u16 length + an encoded CVARS message: the replicated block the first tick ran |
 * | records | kind u8, tick u32, length u16, then the exact wire message |
 *
 * Record kinds: 1 SNAPSHOT (a spectator snapshot: every player, no local block, never deferred,
 * at most MAX_SPECTATOR_SNAPSHOT_BYTES; a full keyframe at the start and every
 * DEMO_KEYFRAME_TICKS ticks, else a delta against the tick before), 2 EVENTS, 3 CVARS, 0 END
 * (length 0, the last bytes of the file). A tick's records come CVARS, SNAPSHOT, EVENTS; ticks
 * never step back. Every frame's slots have stamp = the tick (nothing is deferred).
 */
export const DEMO_MAGIC = "ISDM";
/** The file layout above (design). */
export const DEMO_VERSION = 1;
/** Ticks between full keyframes (design: 10 s at 60 Hz); the first record is one too. */
export const DEMO_KEYFRAME_TICKS = 600;

export const DEMO_REC_END = 0;
export const DEMO_REC_SNAPSHOT = 1;
export const DEMO_REC_EVENTS = 2;
export const DEMO_REC_CVARS = 3;
/** The record header: kind u8, tick u32, length u16. */
export const DEMO_RECORD_HEADER_BYTES = 7;
/** The largest message a record carries (EVENTS and CVARS; a SNAPSHOT is at most 2048 B). */
export const DEMO_RECORD_MAX_BYTES = MAX_RELIABLE_BYTES;

/**
 * A demo name as `record [name]` takes it (design): lowercase letters, digits, `_` and `-`, 1 to
 * 64 chars, so it can never name a path outside the demos folder. The file is `<name>.demo`.
 */
export const DEMO_NAME = /^[a-z0-9_-]{1,64}$/;
/** Map names a demo header may carry: the server's map ids. */
const MAP_NAME = /^[a-z0-9_]{1,63}$/;

/** The file header (everything before the first record). */
export class DemoHeader {
  demoVersion = DEMO_VERSION;
  protocolVersion = PROTOCOL_VERSION;
  tickRate = TICK_RATE;
  startTick = 0;
  mapName = "";
  mapHashLo = 0;
  mapHashHi = 0;
  buildHash = "";
  /** The replicated block at the start, with its effective tick. */
  readonly cvars = new CvarsMsg();
  /** Bytes the header takes: where the first record starts (decode only). */
  length = 0;
}

/** The map's contentHash as the cmap writes it: 16 lowercase hex digits, high lane first. */
export function demoMapHash(h: DemoHeader): string {
  return (
    (h.mapHashHi >>> 0).toString(16).padStart(8, "0") +
    (h.mapHashLo >>> 0).toString(16).padStart(8, "0")
  );
}

function isPrintableAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/**
 * Why a demo of map `mapName` on build `buildHash` cannot be recorded (its header could not carry
 * them), or null. `record` asks this before it opens a file, so a refused name never leaves an
 * empty file behind.
 */
export function demoHeaderProblem(mapName: string, buildHash: string): string | null {
  if (!MAP_NAME.test(mapName)) return `the map name "${mapName}" is not a map id`;
  if (buildHash.length > SHORT_TEXT_MAX || !isPrintableAscii(buildHash)) {
    return "the build hash is not short printable ASCII";
  }
  return null;
}

/**
 * The header's bytes for `h` (its `cvars` block and effective tick encoded as a CVARS message), or
 * null when a field does not fit the layout: a map name that is not a map id, a build hash that is
 * not printable ASCII of at most 63 chars, a start tick outside 1…TICK_MAX, or a block CVARS
 * refuses. Rare (once a recording), so it allocates.
 */
export function encodeDemoHeader(h: DemoHeader): Uint8Array | null {
  if (demoHeaderProblem(h.mapName, h.buildHash) !== null) return null;
  if (!(h.startTick >= 1 && h.startTick <= TICK_MAX)) return null;
  const w = new BitWriter(MAX_RELIABLE_BYTES);
  if (!encodeCvars(w, h.cvars)) return null;
  const cvarLen = w.byteLength;
  const out = new Uint8Array(
    4 + 2 + 2 + 1 + 4 + 1 + h.mapName.length + 8 + 1 + h.buildHash.length + 2 + cvarLen,
  );
  const v = new DataView(out.buffer);
  let at = 0;
  for (let i = 0; i < 4; i++) out[at++] = DEMO_MAGIC.charCodeAt(i);
  v.setUint16(at, h.demoVersion, true);
  at += 2;
  v.setUint16(at, h.protocolVersion, true);
  at += 2;
  out[at++] = h.tickRate;
  v.setUint32(at, h.startTick, true);
  at += 4;
  out[at++] = h.mapName.length;
  for (let i = 0; i < h.mapName.length; i++) out[at++] = h.mapName.charCodeAt(i);
  v.setUint32(at, h.mapHashLo >>> 0, true);
  at += 4;
  v.setUint32(at, h.mapHashHi >>> 0, true);
  at += 4;
  out[at++] = h.buildHash.length;
  for (let i = 0; i < h.buildHash.length; i++) out[at++] = h.buildHash.charCodeAt(i);
  v.setUint16(at, cvarLen, true);
  at += 2;
  out.set(w.bytes.subarray(0, cvarLen), at);
  return out;
}

/** Writes a record header (kind, tick, length) at `at` of `out`; returns the offset after it. */
export function writeDemoRecordHeader(
  out: Uint8Array,
  at: number,
  kind: number,
  tick: number,
  length: number,
): number {
  out[at] = kind;
  out[at + 1] = tick & 0xff;
  out[at + 2] = (tick >>> 8) & 0xff;
  out[at + 3] = (tick >>> 16) & 0xff;
  out[at + 4] = (tick >>> 24) & 0xff;
  out[at + 5] = length & 0xff;
  out[at + 6] = (length >>> 8) & 0xff;
  return at + DEMO_RECORD_HEADER_BYTES;
}

function u16(b: Uint8Array, at: number): number {
  return (b[at] as number) | ((b[at + 1] as number) << 8);
}

function u32(b: Uint8Array, at: number): number {
  return (
    ((b[at] as number) |
      ((b[at + 1] as number) << 8) |
      ((b[at + 2] as number) << 16) |
      ((b[at + 3] as number) << 24)) >>>
    0
  );
}

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[at + i] as number);
  return s;
}

/** Copies `len` bytes of `src` from `from` to the start of `dst` (no subarray view: no garbage). */
export function copyDemoBytes(dst: Uint8Array, src: Uint8Array, from: number, len: number): void {
  for (let i = 0; i < len; i++) dst[i] = src[from + i] as number;
}

/**
 * Reads the header of the demo in the first `length` bytes of `bytes` into `out` (`out.length`
 * is where the records start). Returns null, or why it is not a demo this build reads. Never
 * throws.
 */
export function decodeDemoHeader(
  bytes: Uint8Array,
  length: number,
  out: DemoHeader,
): string | null {
  const n = Math.max(0, Math.min(length, bytes.length));
  if (n < 4 || ascii(bytes, 0, 4) !== DEMO_MAGIC) return "not a demo file (no ISDM magic)";
  let at = 4;
  if (at + 2 + 2 + 1 + 4 + 1 > n) return "the header is cut short";
  out.demoVersion = u16(bytes, at);
  at += 2;
  if (out.demoVersion !== DEMO_VERSION) {
    return `demo version ${out.demoVersion} is not supported (this build reads ${DEMO_VERSION})`;
  }
  out.protocolVersion = u16(bytes, at);
  at += 2;
  if (out.protocolVersion !== PROTOCOL_VERSION) {
    return `recorded with protocol ${out.protocolVersion}; this build speaks ${PROTOCOL_VERSION}`;
  }
  out.tickRate = bytes[at++] as number;
  if (out.tickRate !== TICK_RATE) return `tick rate ${out.tickRate} is not ${TICK_RATE}`;
  out.startTick = u32(bytes, at);
  at += 4;
  if (out.startTick < 1 || out.startTick > TICK_MAX)
    return `start tick ${out.startTick} is out of range`;
  const mapLen = bytes[at++] as number;
  if (at + mapLen + 8 + 1 > n) return "the header is cut short";
  out.mapName = ascii(bytes, at, mapLen);
  at += mapLen;
  if (!MAP_NAME.test(out.mapName)) return "the map name is not a map id";
  out.mapHashLo = u32(bytes, at) | 0;
  out.mapHashHi = u32(bytes, at + 4) | 0;
  at += 8;
  const buildLen = bytes[at++] as number;
  if (at + buildLen + 2 > n) return "the header is cut short";
  out.buildHash = ascii(bytes, at, buildLen);
  at += buildLen;
  if (buildLen > SHORT_TEXT_MAX || !isPrintableAscii(out.buildHash)) {
    return "the build hash is not short printable ASCII";
  }
  const cvarLen = u16(bytes, at);
  at += 2;
  if (at + cvarLen > n) return "the header's cvar block is cut short";
  const r = new BitReader();
  r.reset(bytes.subarray(at, at + cvarLen), cvarLen);
  if (!decodeCvars(r, out.cvars)) return "the header's cvar block does not decode";
  at += cvarLen;
  out.length = at;
  return null;
}

/**
 * Walks a demo's records (after its header) without allocating: `next()` reads one record header
 * into `kind`, `tick`, `offset` (where its message starts) and `size`, checking only that it fits
 * the file and its kind's cap; `error` says why it stopped short of END. A validated demo
 * (`validateDemo`) reads to its END with no error.
 */
export class DemoReader {
  kind = DEMO_REC_END;
  tick = 0;
  offset = 0;
  size = 0;
  /** The record header's offset. */
  at = 0;
  /** null, or why the walk stopped before an END. */
  error: string | null = null;
  /** The END record was read. */
  ended = false;
  private bytes: Uint8Array = new Uint8Array(0);
  private end = 0;
  private pos = 0;

  reset(bytes: Uint8Array, length: number, start: number): void {
    this.bytes = bytes;
    this.end = Math.max(0, Math.min(length, bytes.length));
    this.pos = start;
    this.error = null;
    this.ended = false;
    this.kind = DEMO_REC_END;
    this.tick = 0;
    this.offset = start;
    this.size = 0;
  }

  /** The next record, or false at the END (`ended`) or a fault (`error`). */
  next(): boolean {
    if (this.ended || this.error !== null) return false;
    const b = this.bytes;
    const at = this.pos;
    this.at = at;
    if (at >= this.end) {
      this.error = `no END record: the file is cut short at byte ${at}`;
      return false;
    }
    if (at + DEMO_RECORD_HEADER_BYTES > this.end) {
      this.error = `the record at byte ${at} is cut short`;
      return false;
    }
    const kind = b[at] as number;
    const tick = u32(b, at + 1);
    const size = u16(b, at + 5);
    const offset = at + DEMO_RECORD_HEADER_BYTES;
    if (kind > DEMO_REC_CVARS) {
      this.error = `unknown record kind ${kind} at byte ${at}`;
      return false;
    }
    const cap =
      kind === DEMO_REC_END
        ? 0
        : kind === DEMO_REC_SNAPSHOT
          ? MAX_SPECTATOR_SNAPSHOT_BYTES
          : DEMO_RECORD_MAX_BYTES;
    if (size > cap) {
      this.error = `the record at byte ${at} is ${size} B, over its kind's ${cap} B`;
      return false;
    }
    if (offset + size > this.end) {
      this.error = `the record at byte ${at} runs past the end of the file (cut short)`;
      return false;
    }
    this.kind = kind;
    this.tick = tick;
    this.offset = offset;
    this.size = size;
    this.pos = offset + size;
    if (kind === DEMO_REC_END) {
      this.ended = true;
      if (this.pos !== this.end) {
        this.error = `${this.end - this.pos} B after the END record at byte ${at}`;
      }
      return false;
    }
    return true;
  }
}

/** What `validateDemo` hands a visitor: each record as decoded, in file order. */
export interface DemoVisitor {
  /** A SNAPSHOT: its header and the frame the playback holds for its tick (reused). */
  snapshot?(tick: number, hdr: SnapshotHeader, frame: WorldFrame, bytes: number): void;
  events?(tick: number, m: EventsMsg): void;
  cvars?(tick: number, m: CvarsMsg): void;
}

/** A demo's records by kind and its snapshots' sizes, as `validateDemo` counted them. */
export class DemoSummary {
  snapshots = 0;
  events = 0;
  cvars = 0;
  /** Full snapshots (baseBack 0): the first and one every DEMO_KEYFRAME_TICKS. */
  keyframes = 0;
  snapshotBytes = 0;
  snapshotBytesMax = 0;
  /** The first and last snapshot ticks (0 without any) and the END record's tick. */
  firstTick = 0;
  lastTick = 0;
  endTick = 0;
  /** The file's bytes. */
  bytes = 0;
}

export type DemoCheck =
  | { readonly ok: true; readonly header: DemoHeader; readonly summary: DemoSummary }
  | { readonly ok: false; readonly error: string };

function bad(error: string): DemoCheck {
  return { ok: false, error };
}

/** What a validation decodes into: kept between calls (a fuzz run checks thousands of files). */
class ValidateScratch {
  readonly ring = new FrameRing();
  spare = new WorldFrame();
  readonly hdr = new SnapshotHeader();
  readonly events = new EventsMsg();
  readonly cvars = new CvarsMsg();
  readonly bytes = new Uint8Array(DEMO_RECORD_MAX_BYTES);
  readonly reader = new BitReader();
  readonly demo = new DemoReader();
  busy = false;
}

let shared: ValidateScratch | null = null;
const NO_BYTES = new Uint8Array(0);

/**
 * Checks a whole demo (D-044): the header, then every record in order (its kind, size and tick:
 * ticks never step back and never come before the start, snapshots strictly ascending), every
 * message decoded as playback decodes it (spectator snapshots only, the first a full keyframe at
 * or after the start tick,
 * each delta against a snapshot held; every slot's stamp the tick; EVENTS and CVARS by their
 * codecs), and an END record as the last bytes. Returns the header and the counts, or the first
 * fault with its byte offset. Never throws, whatever the bytes; it allocates a fixed set of frames
 * (64 + 1) and the header's strings, never in proportion to what the file claims.
 */
export function validateDemo(
  bytes: Uint8Array,
  length = bytes.length,
  visitor: DemoVisitor | null = null,
): DemoCheck {
  const header = new DemoHeader();
  const n = Math.max(0, Math.min(length, bytes.length));
  const why = decodeDemoHeader(bytes, n, header);
  if (why !== null) return bad(why);
  // One set of frames, reused unless a visitor validates another demo from inside this one.
  let x = shared;
  if (x === null || x.busy) x = new ValidateScratch();
  if (shared === null) shared = x;
  x.busy = true;
  try {
    return validateRecords(bytes, n, header, visitor, x);
  } finally {
    // The scratch outlives the call: it must not keep the file reachable.
    x.demo.reset(NO_BYTES, 0, 0);
    x.busy = false;
  }
}

function validateRecords(
  bytes: Uint8Array,
  n: number,
  header: DemoHeader,
  visitor: DemoVisitor | null,
  x: ValidateScratch,
): DemoCheck {
  const summary = new DemoSummary();
  summary.bytes = n;
  const ring = x.ring;
  ring.clear();
  const { hdr, events, cvars, reader: r, demo: rd } = x;
  const scratch = x.bytes;
  rd.reset(bytes, n, header.length);
  let lastTick = header.startTick;
  let lastSnap = 0;
  while (rd.next()) {
    const at = rd.at;
    const tick = rd.tick;
    if (tick < lastTick) return bad(`the record at byte ${at} steps back to tick ${tick}`);
    if (tick > TICK_MAX) return bad(`the record at byte ${at} has tick ${tick} past TICK_MAX`);
    lastTick = tick;
    const size = rd.size;
    copyDemoBytes(scratch, bytes, rd.offset, size);
    r.reset(scratch, size);
    if (rd.kind === DEMO_REC_SNAPSHOT) {
      if (size === 0 || scratch[0] !== MSG_SNAPSHOT)
        return bad(`the record at byte ${at} is no SNAPSHOT`);
      if (!decodeSnapshotHeader(r, hdr)) return bad(`the SNAPSHOT at byte ${at} does not decode`);
      if ((hdr.flags & SNAP_FLAG_SPECTATOR) === 0) {
        return bad(`the SNAPSHOT at byte ${at} is not a spectator snapshot`);
      }
      if (hdr.serverTick !== tick) {
        return bad(`the SNAPSHOT at byte ${at} is of tick ${hdr.serverTick}, its record ${tick}`);
      }
      if (tick <= lastSnap) return bad(`the SNAPSHOT at byte ${at} repeats tick ${tick}`);
      let base: WorldFrame | null = null;
      if (hdr.baseBack !== 0) {
        base = ring.get(tick - hdr.baseBack);
        if (base === null) {
          return bad(
            `the SNAPSHOT at byte ${at} is a delta against tick ${tick - hdr.baseBack}, which the demo does not hold`,
          );
        }
      }
      // The first SNAPSHOT is a keyframe, at or after the start tick (a recorder whose start-tick
      // snapshot failed writes its keyframe a tick later). Defence in depth, unreachable today:
      // the ring is empty before the first snapshot, so a first delta was refused just above.
      if (lastSnap === 0 && base !== null) return bad("the first SNAPSHOT is not a keyframe");
      const spare = x.spare;
      if (!decodeSnapshotBody(r, hdr, base, -1, spare)) {
        return bad(`the SNAPSHOT at byte ${at} does not decode`);
      }
      // Defence in depth, unreachable today: a spectator snapshot has no deferred list (refused
      // by decodeSnapshotBody) and finishUnlisted stamps every other present slot with the tick.
      for (let s = 0; s < FRAME_SLOTS; s++) {
        if (spare.present[s] === 1 && spare.stamp[s] !== tick) {
          return bad(`the SNAPSHOT at byte ${at} holds a slot of another tick`);
        }
      }
      x.spare = ring.swapIn(tick, spare);
      const frame = spare;
      lastSnap = tick;
      summary.snapshots++;
      if (hdr.baseBack === 0) summary.keyframes++;
      summary.snapshotBytes += size;
      if (size > summary.snapshotBytesMax) summary.snapshotBytesMax = size;
      if (summary.firstTick === 0) summary.firstTick = tick;
      summary.lastTick = tick;
      visitor?.snapshot?.(tick, hdr, frame, size);
    } else if (rd.kind === DEMO_REC_EVENTS) {
      if (size === 0 || scratch[0] !== MSG_EVENTS || !decodeEvents(r, events)) {
        return bad(`the EVENTS at byte ${at} does not decode`);
      }
      summary.events++;
      visitor?.events?.(tick, events);
    } else {
      if (size === 0 || scratch[0] !== MSG_CVARS || !decodeCvars(r, cvars)) {
        return bad(`the CVARS at byte ${at} does not decode`);
      }
      summary.cvars++;
      visitor?.cvars?.(tick, cvars);
    }
  }
  if (rd.error !== null) return bad(rd.error);
  if (rd.tick < lastTick)
    return bad(`the END record at byte ${rd.at} steps back to tick ${rd.tick}`);
  summary.endTick = rd.tick;
  return { ok: true, header, summary };
}
