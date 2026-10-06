import { type Vec3, vec3 } from "../../math/vec3";
import type { TraceResult } from "../../world/trace";

/**
 * PmoveTraceLog (M2 design §2): the traces pmove ran, for the client's `r_debugTraces` draw and
 * for tests. An observer only: pmove writes it when one is passed and never reads it back, so a
 * tick simulates the same with or without it. Production paths (the server, prediction replays)
 * pass null.
 */

export const PMOVE_TRACE_LOG_CAPACITY = 64;

/** Doubles per record: start, end, endpos, normal, mins, maxs (3 each), then fraction. */
const STRIDE = 19;
const BIT_START_SOLID = 1;
const BIT_ALL_SOLID = 2;

/** One trace copied out of the log by `PmoveTraceLog.read`. */
export class PmoveTraceRecord {
  readonly start: Vec3 = vec3();
  readonly end: Vec3 = vec3();
  readonly endpos: Vec3 = vec3();
  /** Zero when nothing was hit. */
  readonly normal: Vec3 = vec3();
  readonly mins: Vec3 = vec3();
  readonly maxs: Vec3 = vec3();
  fraction = 1;
  startSolid = false;
  allSolid = false;
}

function put(data: Float64Array, o: number, v: Vec3): void {
  data[o] = v[0];
  data[o + 1] = v[1];
  data[o + 2] = v[2];
}

function get(data: Float64Array, o: number, out: Vec3): void {
  out[0] = data[o] as number;
  out[1] = data[o + 1] as number;
  out[2] = data[o + 2] as number;
}

/**
 * Ring of the last PMOVE_TRACE_LOG_CAPACITY traces, oldest first, in typed arrays so recording
 * never allocates. The owner clears it per frame or per tick, as it likes; older records are
 * overwritten and `total` keeps counting.
 */
export class PmoveTraceLog {
  private readonly data = new Float64Array(PMOVE_TRACE_LOG_CAPACITY * STRIDE);
  private readonly bits = new Uint8Array(PMOVE_TRACE_LOG_CAPACITY);
  private head = 0;
  private size = 0;
  /** Traces recorded since the last `clear`, including overwritten ones. */
  total = 0;

  get count(): number {
    return this.size;
  }

  record(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, tr: TraceResult): void {
    let slot = this.head + this.size;
    if (this.size === PMOVE_TRACE_LOG_CAPACITY) {
      slot = this.head;
      this.head = (this.head + 1) % PMOVE_TRACE_LOG_CAPACITY;
    } else {
      this.size++;
    }
    slot %= PMOVE_TRACE_LOG_CAPACITY;
    const d = this.data;
    const o = slot * STRIDE;
    put(d, o, start);
    put(d, o + 3, end);
    put(d, o + 6, tr.endpos);
    put(d, o + 9, tr.normal);
    put(d, o + 12, mins);
    put(d, o + 15, maxs);
    d[o + 18] = tr.fraction;
    this.bits[slot] = (tr.startSolid ? BIT_START_SOLID : 0) | (tr.allSolid ? BIT_ALL_SOLID : 0);
    this.total++;
  }

  /**
   * Copies record `i` (0 = oldest) into `out` and returns true; any other index (outside
   * [0, count), fractional, NaN) returns false and leaves `out` as it was.
   */
  read(i: number, out: PmoveTraceRecord): boolean {
    if ((i | 0) !== i || i < 0 || i >= this.size) return false;
    const slot = (this.head + i) % PMOVE_TRACE_LOG_CAPACITY;
    const d = this.data;
    const o = slot * STRIDE;
    get(d, o, out.start);
    get(d, o + 3, out.end);
    get(d, o + 6, out.endpos);
    get(d, o + 9, out.normal);
    get(d, o + 12, out.mins);
    get(d, o + 15, out.maxs);
    out.fraction = d[o + 18] as number;
    const b = this.bits[slot] as number;
    out.startSolid = (b & BIT_START_SOLID) !== 0;
    out.allSolid = (b & BIT_ALL_SOLID) !== 0;
    return true;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
    this.total = 0;
  }
}
