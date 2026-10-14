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
/**
 * The M4 kinds (M4 design §2.2, D-053), emitted from the increment that gives each its meaning.
 * Kinds 4–7 go on the wire in a remote's entity record; 8–11 stay local (remotes derive slides from
 * the SLIDING flag's edges and a hurt sound from LAND's value), so the two event slots stay enough.
 */
/** Wall jump (M4 design §2.6); value = 0. */
export const PMEV_WALLKICK = 4;
/** Ledge grab (§2.8); value = 0. */
export const PMEV_GRAB = 5;
/** Boot hit (§2.11); value = the victim's client id (< 64). */
export const PMEV_BOOT = 6;
/** Water-jump out over a rim (§2.10); value = 0. */
export const PMEV_WATER_JUMP = 7;
/** The highest kind an entity record carries; above it a kind is local only. */
export const PMEV_WIRE_MAX = PMEV_WATER_JUMP;
/** Power slide started (§2.7); local only. */
export const PMEV_SLIDE_START = 8;
/** Power slide ended (§2.7); local only. */
export const PMEV_SLIDE_END = 9;
/** Fall damage taken (§2.5); value = damage in hundredths; local only. */
export const PMEV_FALL_DAMAGE = 10;
/** Landed on a player's head at goomba speed (§2.11); value = the victim's id; local only. */
export const PMEV_GOOMBA = 11;

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
    this.values[this.claim(type)] = value;
  }

  /**
   * push(type, src[index]). Per-tick callers (pmove) use this so the value never crosses a call
   * as a double, which V8 boxes when the call isn't inlined (native ESM).
   */
  pushFrom(type: number, src: Float64Array, index: number): void {
    this.values[this.claim(type)] = src[index] as number;
  }

  /** Takes the next slot (dropping the oldest event when full), stores `type`, returns the slot. */
  private claim(type: number): number {
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
    return slot;
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
