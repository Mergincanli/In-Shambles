import { DEV_ASSERT } from "../debug/assert";
import { MAX_UNRELIABLE_BYTES } from "./protocol";

/**
 * Pooled packet copies ordered by due time, for the loopback pair and the net simulator
 * (docs/05 §3.1, D-026). Each slot owns a byte buffer that is reused for every packet it holds,
 * so once the pool has grown to the most packets in flight at once, pushing and taking allocate
 * nothing (only a reliable message larger than any its slot held before still grows that slot).
 * Receivers cap the unreliable packets they hold (`MAX_QUEUED_UNRELIABLE`), so a receiver that
 * stops polling (a hidden tab) does not grow its pool for the rest of the session.
 *
 * Packets come out in due order; equal due times keep push order, so a queue whose dues never
 * fall (loopback: all 0; a FIFO channel) is plain FIFO.
 */

/**
 * A new slot's buffer holds any unreliable packet, so the per-tick traffic never grows one; a
 * reliable message past it (a large CVARS block) grows its slot once to the next power of two.
 */
const MIN_SLOT_BYTES = MAX_UNRELIABLE_BYTES;
const INITIAL_SLOTS = 16;

/** Slot flag: the packet came on the reliable channel. */
export const PACKET_RELIABLE = 1;
/** Slot flag: not a packet but the peer's close, ordered behind what it sent before (netsim). */
export const PACKET_CLOSE = 2;

function isUnreliable(flags: number): boolean {
  return (flags & (PACKET_RELIABLE | PACKET_CLOSE)) === 0;
}

export class PacketQueue {
  private bufs: Uint8Array[] = [];
  private lens = new Int32Array(INITIAL_SLOTS);
  private flags = new Uint8Array(INITIAL_SLOTS);
  private dues = new Float64Array(INITIAL_SLOTS);
  /** Free slot ids (a stack, so recently used and warm buffers come back first). */
  private free = new Int32Array(INITIAL_SLOTS);
  private freeCount = 0;
  /** Queued slot ids in due order, from `head` to `head + count`. */
  private order = new Int32Array(INITIAL_SLOTS);
  private head = 0;
  private count = 0;
  /** Queued packets that are neither reliable nor a close. */
  private unreliable = 0;

  constructor() {
    for (let i = 0; i < INITIAL_SLOTS; i++) {
      this.bufs.push(new Uint8Array(MIN_SLOT_BYTES));
      this.free[this.freeCount++] = INITIAL_SLOTS - 1 - i;
    }
  }

  get length(): number {
    return this.count;
  }

  /** Queued unreliable packets (receivers cap them, `MAX_QUEUED_UNRELIABLE`). */
  get unreliableLength(): number {
    return this.unreliable;
  }

  /** Slots owned, queued or free: constant once the queue is warm (the pooling tests read it). */
  get slotCount(): number {
    return this.bufs.length;
  }

  /**
   * Copies `d[0, len)` into a slot due at `times[at]`. Due times are fractional milliseconds, so
   * they travel in a typed array: a double passed to or returned from a call V8 doesn't inline is
   * boxed under native ES modules.
   */
  push(d: Uint8Array, len: number, flags: number, times: Float64Array, at: number): void {
    const id = this.acquire(len);
    const buf = this.bufs[id] as Uint8Array;
    for (let i = 0; i < len; i++) buf[i] = d[i] as number;
    this.lens[id] = len;
    this.flags[id] = flags;
    this.dues[id] = times[at] as number;
    if (isUnreliable(flags)) this.unreliable++;
    this.insert(id);
  }

  /** Whether the first packet is due by `times[at]` (false when empty). */
  dueBy(times: Float64Array, at: number): boolean {
    if (this.count === 0) return false;
    return (this.dues[this.order[this.head] as number] as number) <= (times[at] as number);
  }

  /** Writes the first packet's due time to `out[at]`; false (and nothing written) when empty. */
  frontDue(out: Float64Array, at: number): boolean {
    if (this.count === 0) return false;
    out[at] = this.dues[this.order[this.head] as number] as number;
    return true;
  }

  /**
   * Removes the first packet and returns its slot id (−1 when empty). The slot stays owned by the
   * caller, its bytes intact, until `release`, so a callback may push or clear meanwhile.
   */
  take(): number {
    if (this.count === 0) return -1;
    const id = this.order[this.head] as number;
    this.head++;
    this.count--;
    if (this.count === 0) this.head = 0;
    if (isUnreliable(this.flags[id] as number)) this.unreliable--;
    return id;
  }

  /**
   * Drops the first queued unreliable packet (false when there is none); reliable packets and a
   * close keep their places. A receiver that fell behind keeps the newest packets this way.
   */
  dropOldestUnreliable(): boolean {
    const order = this.order;
    const head = this.head;
    const end = head + this.count;
    let i = head;
    while (i < end && !isUnreliable(this.flags[order[i] as number] as number)) i++;
    if (i === end) return false;
    const id = order[i] as number;
    // Shift the reliable packets ahead of it back one place, keeping their order.
    for (; i > head; i--) order[i] = order[i - 1] as number;
    this.head++;
    this.count--;
    if (this.count === 0) this.head = 0;
    this.unreliable--;
    this.release(id);
    return true;
  }

  bytesOf(id: number): Uint8Array {
    return this.bufs[id] as Uint8Array;
  }

  lengthOf(id: number): number {
    return this.lens[id] as number;
  }

  flagsOf(id: number): number {
    return this.flags[id] as number;
  }

  release(id: number): void {
    this.free[this.freeCount++] = id;
  }

  /** Drops every queued packet (slots taken but not yet released stay with their taker). */
  clear(): void {
    for (let i = 0; i < this.count; i++) this.release(this.order[this.head + i] as number);
    this.head = 0;
    this.count = 0;
    this.unreliable = 0;
  }

  private acquire(len: number): number {
    if (this.freeCount === 0) this.grow();
    const id = this.free[--this.freeCount] as number;
    const buf = this.bufs[id] as Uint8Array;
    if (buf.length < len) {
      let size = 2048;
      while (size < len) size *= 2;
      this.bufs[id] = new Uint8Array(size);
    }
    return id;
  }

  /** Doubles the slot pool (warm-up only: more packets in flight than ever before). */
  private grow(): void {
    const old = this.bufs.length;
    const size = old * 2;
    for (let i = old; i < size; i++) this.bufs.push(new Uint8Array(MIN_SLOT_BYTES));
    this.lens = copyInto(new Int32Array(size), this.lens);
    this.flags = copyInto(new Uint8Array(size), this.flags);
    this.dues = copyInto(new Float64Array(size), this.dues);
    this.free = new Int32Array(size);
    for (let i = size - 1; i >= old; i--) this.free[this.freeCount++] = i;
    const order = new Int32Array(size);
    for (let i = 0; i < this.count; i++) order[i] = this.order[this.head + i] as number;
    this.order = order;
    this.head = 0;
  }

  /** Inserts `id` behind every packet due no later than it, scanning from the back. */
  private insert(id: number): void {
    // Every slot is owned by `order` or `free`, so a free slot leaves room in `order`; it may
    // only need moving down to the front.
    if (this.head + this.count === this.order.length) {
      this.order.copyWithin(0, this.head, this.head + this.count);
      this.head = 0;
    }
    const due = this.dues[id] as number;
    const order = this.order;
    let i = this.head + this.count;
    while (i > this.head && (this.dues[order[i - 1] as number] as number) > due) {
      order[i] = order[i - 1] as number;
      i--;
    }
    order[i] = id;
    this.count++;
    if (this.count > order.length) DEV_ASSERT(false, "packet queue overflow", this.count);
  }
}

function copyInto<T extends Int32Array | Uint8Array | Float64Array>(to: T, from: T): T {
  to.set(from);
  return to;
}
