/**
 * Session security (M3 design §2.13, D-041; docs/05 §12): the per-session token buckets that rate
 * limit each channel, the decaying strike score that warns and kicks, and the settings both read.
 * Pure integer arithmetic on fixed-shape objects, allocation-free: it runs per packet and per tick.
 */

/** Fixed-point units of one token (design value): a refill of 0.25 per tick stays an integer. */
export const TOKEN_UNIT = 4;

/** Unreliable refill: 2 packets per tick, 2 × INPUT_RATE (docs/05 §12; design). */
export const UNRELIABLE_REFILL_UNITS = 2 * TOKEN_UNIT;
/** Reliable refill: 0.25 messages per tick, 15 per second (design). */
export const RELIABLE_REFILL_UNITS = 1;

// Strike weights (M3 design §2.13, design values).
/** A message that does not decode, is over its channel's size, or has no known type. */
export const STRIKE_MALFORMED = 5;
/** A message on the wrong channel or for another session state; an ack past the newest sent. */
export const STRIKE_UNEXPECTED = 2;
/** A tick in which a bucket ran dry and packets were dropped (once per tick). */
export const STRIKE_RATE_LIMITED = 1;
/** Ticks per point of decay: 1 point per second (design). */
export const STRIKE_DECAY_TICKS = 60;

// What `StrikeScore.add` crossed.
export const STRIKE_OK = 0;
/** The score reached the warn level for the first time since it was last 0: one PRINT. */
export const STRIKE_WARN = 1;
/** The score reached the kick level: KICK "too many bad packets". */
export const STRIKE_KICK = 2;

/**
 * The settings a match applies to every session (SERVER cvars on the Node server, docs/06 §8;
 * the defaults elsewhere). Ticks and counts; labels as in the M3 design §4. Per process, shared
 * by every match it runs (M3 design §2.17).
 */
export class SessionLimits {
  /** `sv_timeout`: a welcomed or active session silent this long is KICKed (5 s; design). */
  timeout = 300;
  /** `sv_helloTimeout`: a connection without HELLO this long after it opened (ESTIMATE). */
  helloTimeout = 120;
  /** `sv_handshakeTimeout`: a session still not READY this long after it opened (ESTIMATE). */
  handshakeTimeout = 600;
  /** `sv_starveNeutralTicks`: starved ticks that repeat the last cmd before neutral (ESTIMATE). */
  starveNeutralTicks = 30;
  /** `sv_strikeWarn` / `sv_strikeKick`: strike score that warns once / kicks (ESTIMATEs). */
  strikeWarn = 15;
  strikeKick = 30;
  /** `sv_inputBurst`: unreliable bucket capacity, packets (ESTIMATE, at least 64). */
  inputBurst = 240;
  /** `sv_reliableBurst`: reliable bucket capacity, messages (ESTIMATE). */
  reliableBurst = 20;
}

/**
 * A token bucket in TOKEN_UNIT fixed point: `capacity` tokens, refilled by `refill` units at the
 * start of every tick; each packet takes one token, or is dropped when less than one is left.
 * Starts full, so a client's first burst (the anchor fill, D-028) is never limited.
 */
export class TokenBucket {
  /** Units held, 0…capacityUnits. */
  level = 0;
  capacityUnits = 0;
  refillUnits = 0;

  /** Sets the capacity (tokens) and refill (units per tick), and fills the bucket. */
  configure(capacity: number, refillUnits: number): void {
    this.capacityUnits = capacity * TOKEN_UNIT;
    this.refillUnits = refillUnits;
    this.level = this.capacityUnits;
  }

  /** One tick's refill. */
  refill(): void {
    this.level = Math.min(this.capacityUnits, this.level + this.refillUnits);
  }

  /** Takes one token; false (nothing taken) when the bucket holds less than one. */
  take(): boolean {
    if (this.level < TOKEN_UNIT) return false;
    this.level -= TOKEN_UNIT;
    return true;
  }
}

/**
 * A session's strike score (D-041): weighted points that decay by 1 every STRIKE_DECAY_TICKS
 * while above 0. Reaching `warn` warns once until the score is back to 0; reaching `kick` kicks.
 */
export class StrikeScore {
  score = 0;
  /** Ticks since the last point of decay (or since the score left 0). */
  decayTicks = 0;
  warned = false;

  /** Adds `points`; returns STRIKE_KICK, STRIKE_WARN or STRIKE_OK. */
  add(points: number, warn: number, kick: number): number {
    this.score += points;
    if (this.score >= kick) return STRIKE_KICK;
    if (this.score >= warn && !this.warned) {
      this.warned = true;
      return STRIKE_WARN;
    }
    return STRIKE_OK;
  }

  /** One tick of decay. */
  tick(): void {
    if (this.score === 0) {
      this.decayTicks = 0;
      this.warned = false;
      return;
    }
    if (++this.decayTicks < STRIKE_DECAY_TICKS) return;
    this.decayTicks = 0;
    this.score--;
  }
}
