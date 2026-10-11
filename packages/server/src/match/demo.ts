import {
  BitWriter,
  type CvarBlock,
  DEMO_KEYFRAME_TICKS,
  DEMO_REC_END,
  DEMO_REC_EVENTS,
  DEMO_REC_SNAPSHOT,
  DEMO_RECORD_HEADER_BYTES,
  DEMO_RECORD_MAX_BYTES,
  DEV_ASSERT,
  DemoHeader,
  encodeDemoHeader,
  encodeSnapshot,
  MAX_SPECTATOR_SNAPSHOT_BYTES,
  SNAP_FLAG_SPECTATOR,
  SnapshotHeader,
  writeDemoRecordHeader,
} from "@game/shared";
import type { WorldHistory } from "./history";

/**
 * Where a recording's bytes go (D-044): the Node server's file writer (node/demoWriter.ts) or a
 * test's memory buffer. `write` gets the file in order (the header, then each record whole) and
 * must copy what it keeps: the recorder reuses its buffer. `close` follows the END record.
 */
export interface DemoSink {
  write(bytes: Uint8Array, length: number): void;
  close(): void;
}

/**
 * What `record` asks of the match's host (D-044): a sink for a demo named `name` (already checked
 * against DEMO_NAME), or for the host's default name (`<map>-<utc>`) when null. Returns the sink
 * and the file it writes (for the reply and the logs), or why it can't.
 */
export interface DemoHost {
  open(name: string | null, mapName: string): DemoOpened | string;
}

export interface DemoOpened {
  readonly sink: DemoSink;
  /** The file, as the reply names it (`demos/<name>.demo`). */
  readonly file: string;
}

/** A sink that keeps the file in memory (tests, and the e2e's fixture). Grows by doubling. */
export class MemoryDemoSink implements DemoSink {
  private buf = new Uint8Array(1 << 16);
  length = 0;
  closed = false;

  write(bytes: Uint8Array, length: number): void {
    if (this.length + length > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < this.length + length) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(this.buf.subarray(0, this.length));
      this.buf = grown;
    }
    const b = this.buf;
    const at = this.length;
    for (let i = 0; i < length; i++) b[at + i] = bytes[i] as number;
    this.length = at + length;
  }

  close(): void {
    this.closed = true;
  }

  /** A copy of the file written so far. */
  bytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/**
 * The spectator recorder (D-044, M3 design §2.12): at the end of each tick its match hands it the
 * tick's records: CVARS when the block changed, then a SPECTATOR SNAPSHOT of every player in the
 * world frame (up to 64, never deferred, at most MAX_SPECTATOR_SNAPSHOT_BYTES), a full keyframe at
 * the first tick and every DEMO_KEYFRAME_TICKS ticks after it, else a delta against the world
 * frame of the tick before (what a player holds after the record before), then the tick's
 * broadcast EVENTS. The header goes out with the first tick, so it carries that tick's block. A
 * snapshot that fails to encode (impossible by its size bound) is counted, and the next one is a
 * keyframe. Pure: the host's sink does the I/O. After `start` a tick allocates nothing.
 */
export class DemoRecorder {
  /** The file, while recording (`DemoOpened.file`); "" when idle. */
  file = "";
  /** The first tick recorded, 0 before it; the last tick recorded. */
  startTick = 0;
  lastTick = 0;
  /** Records written (END excluded), the file's bytes, snapshots, keyframes and failed encodes. */
  records = 0;
  bytes = 0;
  snapshots = 0;
  keyframes = 0;
  snapshotBytesMax = 0;
  failed = 0;
  /** The match sends its EVENTS here (`Match.sendEvents`): each message becomes a record. */
  readonly events: { sendReliable(d: Uint8Array, len: number): void };
  private sink: DemoSink | null = null;
  private readonly header = new DemoHeader();
  private readonly snapWriter = new BitWriter(MAX_SPECTATOR_SNAPSHOT_BYTES);
  private readonly snapHeader = new SnapshotHeader();
  private readonly record = new Uint8Array(DEMO_RECORD_HEADER_BYTES + DEMO_RECORD_MAX_BYTES);
  /** The tick whose records are being written. */
  private tick = 0;
  /** The last tick with a snapshot in the file (a delta's baseline), 0 for none. */
  private lastSnapshot = 0;

  constructor() {
    this.events = { sendReliable: (d, len) => this.write(DEMO_REC_EVENTS, this.tick, d, len) };
  }

  get active(): boolean {
    return this.sink !== null;
  }

  /**
   * Starts a recording into `sink`; the header waits for the first tick (`beginTick`). `map` is
   * what the header names: the map, its hash lanes and the server's build.
   */
  start(
    sink: DemoSink,
    file: string,
    map: { readonly name: string; readonly hashLo: number; readonly hashHi: number },
    buildHash: string,
  ): void {
    this.sink = sink;
    this.file = file;
    const h = this.header;
    h.mapName = map.name;
    h.mapHashLo = map.hashLo;
    h.mapHashHi = map.hashHi;
    h.buildHash = buildHash;
    this.startTick = 0;
    this.lastTick = 0;
    this.records = 0;
    this.bytes = 0;
    this.snapshots = 0;
    this.keyframes = 0;
    this.snapshotBytesMax = 0;
    this.failed = 0;
    this.lastSnapshot = 0;
  }

  /**
   * Opens tick `t`'s records. On the first tick it writes the header with `block`, the replicated
   * block tick `t` ran, and the tick it took effect, and returns true, so the match sends its
   * roster burst instead of the tick's events; false after, and when the header does not encode
   * (a bad map name or build hash: the recording then stops). Rare work allocates only then.
   */
  beginTick(t: number, block: CvarBlock, effectiveTick: number): boolean {
    this.tick = t;
    if (this.startTick !== 0 || this.sink === null) return false;
    const h = this.header;
    h.startTick = t;
    h.cvars.effectiveTick = effectiveTick;
    const entries = h.cvars.block.entries;
    entries.length = 0;
    for (const e of block.entries) entries.push(e);
    const bytes = encodeDemoHeader(h);
    if (bytes === null) {
      DEV_ASSERT(false, "demo header did not encode");
      this.failed++;
      this.stop();
      return false;
    }
    this.startTick = t;
    this.lastTick = t;
    this.emit(bytes, bytes.length);
    return true;
  }

  /** A record of `kind` at `tick` holding the message in `d` (copied). */
  write(kind: number, tick: number, d: Uint8Array, len: number): void {
    if (this.sink === null) return;
    const rec = this.record;
    if (len > DEMO_RECORD_MAX_BYTES) {
      DEV_ASSERT(false, "demo record too large", len);
      this.failed++;
      return;
    }
    let at = writeDemoRecordHeader(rec, 0, kind, tick, len);
    for (let i = 0; i < len; i++) rec[at++] = d[i] as number;
    this.emit(rec, at);
    this.records++;
    this.lastTick = tick;
  }

  /**
   * The spectator snapshot of tick `t` from `history` (its frame must be stored), with `cvarHash16`
   * in its header: a keyframe on the first tick, every DEMO_KEYFRAME_TICKS ticks and after a
   * failed encode, else a delta against tick t − 1's frame.
   */
  writeSnapshot(t: number, history: WorldHistory, cvarHash16: number): void {
    if (this.sink === null) return;
    const cur = history.get(t);
    if (cur === null) {
      DEV_ASSERT(false, "demo: the tick's world frame is not stored");
      this.failed++;
      this.lastSnapshot = 0;
      return;
    }
    const keyframe =
      this.lastSnapshot !== t - 1 || (t - this.startTick) % DEMO_KEYFRAME_TICKS === 0;
    const base = keyframe ? null : history.get(t - 1);
    const h = this.snapHeader;
    h.serverTick = t;
    h.baseBack = base === null ? 0 : 1;
    h.flags = SNAP_FLAG_SPECTATOR;
    h.cvarHash = cvarHash16;
    h.inputBufferHealth = 0;
    const w = this.snapWriter;
    w.reset();
    if (!encodeSnapshot(w, h, cur, base, -1)) {
      DEV_ASSERT(false, "demo SNAPSHOT did not encode", t);
      this.failed++;
      this.lastSnapshot = 0;
      return;
    }
    const len = w.byteLength;
    this.write(DEMO_REC_SNAPSHOT, t, w.bytes, len);
    this.lastSnapshot = t;
    this.snapshots++;
    if (base === null) this.keyframes++;
    if (len > this.snapshotBytesMax) this.snapshotBytesMax = len;
  }

  /**
   * Ends the recording: the END record (at the last tick recorded) and the sink's close. Returns
   * the file, or "" when idle. A recording with no header yet (stopped before its first tick, or
   * its header refused) is only closed: `Match.stopRecording` writes the header first so the file
   * is still a valid demo, and `Match.record` refuses a map or build the header can't carry before
   * any file is opened.
   */
  stop(): string {
    const sink = this.sink;
    if (sink === null) return "";
    if (this.startTick !== 0) {
      const rec = this.record;
      const at = writeDemoRecordHeader(rec, 0, DEMO_REC_END, this.lastTick, 0);
      this.emit(rec, at);
    }
    this.sink = null;
    sink.close();
    const file = this.file;
    this.file = "";
    return file;
  }

  private emit(bytes: Uint8Array, len: number): void {
    (this.sink as DemoSink).write(bytes, len);
    this.bytes += len;
  }
}
