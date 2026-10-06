/**
 * Movement events (M2 design §2): pmove output only. They never feed the next tick, so they
 * stay out of `PlayerState`; the client uses them for presentation (step smoothing, sounds).
 * Remote players get them through `eventSeq` in M3.
 */

export const PMEV_NONE = 0;
/** Auto-step up or down; value = signed Δz in u. */
export const PMEV_STEP = 1;
/** Jumped this tick; value = 0. */
export const PMEV_JUMP = 2;
/** Airborne → grounded this tick; value = impact speed in u/s. */
export const PMEV_LAND = 3;

export const PMOVE_EVENTS_CAPACITY = 8;

/** One event copied out of the ring by `PmoveEvents.read`. */
export class PmoveEvent {
  type = PMEV_NONE;
  value = 0;
}

/**
 * Fixed ring of the last PMOVE_EVENTS_CAPACITY events, oldest first. The owner clears it when
 * it has consumed them; a ninth push drops the oldest and counts it in `dropped`, so a burst of
 * catch-up ticks never allocates.
 */
export class PmoveEvents {
  private readonly types = new Uint8Array(PMOVE_EVENTS_CAPACITY);
  private readonly values = new Float64Array(PMOVE_EVENTS_CAPACITY);
  /** Slot of the oldest event. */
  private head = 0;
  private size = 0;
  /** Events overwritten before they were read, since the last `clear`. */
  dropped = 0;

  get count(): number {
    return this.size;
  }

  push(type: number, value: number): void {
    let slot = this.head + this.size;
    if (this.size === PMOVE_EVENTS_CAPACITY) {
      slot = this.head;
      this.head = (this.head + 1) % PMOVE_EVENTS_CAPACITY;
      this.dropped++;
    } else {
      this.size++;
    }
    slot %= PMOVE_EVENTS_CAPACITY;
    this.types[slot] = type;
    this.values[slot] = value;
  }

  /**
   * Copies event `i` (0 = oldest) into `out`; any other index (outside [0, count), fractional,
   * NaN) gives PMEV_NONE, so `out` keeps its number fields.
   */
  read(i: number, out: PmoveEvent): PmoveEvent {
    if ((i | 0) !== i || i < 0 || i >= this.size) {
      out.type = PMEV_NONE;
      out.value = 0;
      return out;
    }
    const slot = (this.head + i) % PMOVE_EVENTS_CAPACITY;
    out.type = this.types[slot] as number;
    out.value = this.values[slot] as number;
    return out;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
    this.dropped = 0;
  }
}
