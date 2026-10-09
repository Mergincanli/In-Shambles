import { PITCH_LIMIT_U16 } from "../math/angles";
import { ORIGIN_LIMIT, ORIGIN_SCALE, toSigned16 } from "../math/quant";
import { ENTITY_FLAG_MASK, ENTITY_WORLD, MATCH_MAX_CLIENTS, TEAM_2 } from "../sim/entity";
import { PMEV_JUMP, PMEV_LAND, PMEV_NONE } from "../sim/events";
import { PlayerState } from "../sim/playerState";
import type { BitReader, BitWriter } from "./bitstream";
import { readTick, writeTick } from "./messages";
import { decodePlayerState, encodePlayerState, PLAYER_STATE_BITS } from "./playerStateCodec";
import {
  MAX_SPECTATOR_SNAPSHOT_BYTES,
  MSG_SNAPSHOT,
  SNAP_BUDGET_BITS,
  SNAP_ENTITY_VELOCITY_D1,
  SNAP_ENTITY_VELOCITY_D2,
  SNAP_FLAG_DEFERRED,
  SNAP_FLAG_MASK,
  SNAP_FLAG_SPECTATOR,
  SNAP_FLAG_STARVED,
  SNAP_LOCAL_VELOCITY_D1,
  SNAP_LOCAL_VELOCITY_D2,
  SNAP_ORIGIN_D1,
  SNAP_ORIGIN_D2,
  SNAPSHOT_HISTORY,
} from "./protocol";
import {
  ENTITY_EVENT_SLOTS,
  ENTITY_VELOCITY_MAX,
  entityVelocity,
  FRAME_SLOTS,
  playerStateToSlot,
  slotToPlayerState,
  type WorldFrame,
} from "./worldFrame";

/**
 * SNAPSHOT, protocol v2 (docs/05 §3.6, M3 design §2.1, D-033, D-038): a header, the receiver's
 * local block, then an entity record per other player that changed against the baseline (entity
 * id = client id), ids ascending. A full snapshot (`baseBack` 0) has no baseline: the full local
 * block and a "new" record per present player. A delta (`baseBack` 1–63) is coded against the
 * frame of tick serverTick − baseBack, which the receiver holds: a delta local block, and a record
 * only for a player that left (removed), appeared or came back as a new incarnation (new), or
 * changed (a delta body); a present player with no record is unchanged since the baseline. Above
 * 37 players the byte-budget scheduler (D-046) may leave players out: their ids follow the records
 * (the deferred list), and the receiver keeps what its baseline holds of them (state and stamp) or,
 * when it holds no state, marks them pending. The server encodes from its world frames (or a
 * client's mirror of what it was sent); the client decodes into a `WorldFrame` of its store.
 *
 * | Field | Bits |
 * |---|---|
 * | type | 8 (5) |
 * | serverTick | 32 (1…TICK_MAX) |
 * | baseBack | 6 (0 = full; 1–63 and at most serverTick − 1 = a delta) |
 * | flags | 8 (SNAP_FLAG_*; bit 1 and bits 4–7 refused, SPECTATOR with STARVED or DEFERRED refused) |
 * | cvarHash | 16 |
 * | inputBufferHealth | 8 (i8; not when spectator) |
 * | teleportSeq | 8 (not when spectator; D-035) |
 * | local block | the full PlayerState, 199; or a delta, 8–219 (not when spectator) |
 * | entityCount | 7 (0…63; 0…64 when spectator) |
 * | entity records | 213 new, 17 removed, 28–233 a delta body |
 * | deferred list | only with DEFERRED: count 6 (1…63), then ids u16 strictly ascending |
 *
 * A full ("new") entity record: id 16 (< 64; the receiver's own refused unless spectator), removed
 * 1 (0), new 1 (1), origin 3 × i21 (1/32 u, ±16384 u), velocity 3 × i16 (1 u/s, ±32767), yaw 16,
 * pitch 16 (±16201), flags 10 (within ENTITY_FLAG_MASK), team 2 (0–2), teleportSeq 8, eventSeq 8,
 * two events of kind 4 (0 none, 1 STEP, 2 JUMP, 3 LAND) + value 8 (0 when empty; JUMP's is 0; an
 * empty first slot needs an empty second). A removal is id 16 + removed 1 (1), only for a slot the
 * baseline holds. A delta record is id 16, removed 0, new 0, a field mask 8 (origin, velocity,
 * yaw, pitch, flags, team, teleportSeq, events; never 0), then the set fields: origin and velocity
 * per axis a 2-bit class (0 same, 1 and 2 a difference, 3 the absolute value at the new body's
 * width), the rest at the new body's widths. The delta local block is a mask 8 (origin, velocity,
 * yaw, pitch, flags, groundEntity + 1, waterLevel, stamina; 0 = unchanged), then the set fields at
 * the full block's widths, origin and velocity class-coded like an entity's.
 *
 * "New" is a body format, not an incarnation signal (the client snaps on teleportSeq, D-035): the
 * encoder writes it when the baseline has no state for the slot, or holds another incarnation (a
 * different server `serial`), never by size, so the encoding stays canonical.
 *
 * A deferred id is never the receiver's own, never also a record, and never a slot that needs a
 * removal (removals are never deferred). In a delta, one whose baseline slot has state keeps that
 * state and its stamp (an older tick than the snapshot's); one whose baseline slot is pending or
 * absent, and every deferred id of a full snapshot, becomes pending (present, stamp 0).
 *
 * Canonical: a packet the decoder accepts re-encodes to the same bytes against the same baseline
 * (NET-01): the smallest class always, no set field or group equal to the baseline, a record only
 * when one is needed, the DEFERRED flag exactly when an id is deferred. Decoding yields the frame
 * it was encoded from, as the receiver holds it (frameDigest). A live snapshot is at most
 * MAX_SNAPSHOT_BYTES (the encoder refuses more, so the decoder does too); a spectator one (demo
 * files only) at most MAX_SPECTATOR_SNAPSHOT_BYTES. Neither side allocates, refusals included.
 */

/** Header bits with the type byte (M3 design §2.1): 86, or 70 without health and teleportSeq. */
export const SNAP_HEADER_BITS = 86;
export const SNAP_SPECTATOR_HEADER_BITS = 70;
export const SNAP_ENTITY_COUNT_BITS = 7;
/** A full entity record, id, removed and new bits included. */
export const ENTITY_NEW_BITS = 213;
/** A removal: id and the removed bit. */
export const ENTITY_REMOVED_BITS = 17;
/** The largest delta entity record: every field set, origin and velocity absolute. */
export const ENTITY_DELTA_MAX_BITS = 233;
/** The largest delta local block: every field set, origin and velocity absolute. */
export const LOCAL_DELTA_MAX_BITS = 219;
/** A full live snapshot with no other player: header, local block, entity count. */
export const SNAP_FULL_FIXED_BITS = SNAP_HEADER_BITS + PLAYER_STATE_BITS + SNAP_ENTITY_COUNT_BITS;
/** The largest delta live snapshot with no record: header, the largest local block, count (312). */
export const SNAP_DELTA_FIXED_BITS =
  SNAP_HEADER_BITS + LOCAL_DELTA_MAX_BITS + SNAP_ENTITY_COUNT_BITS;
/** The deferred list's count (1…63) and each deferred id (u16, `docs/05` §4.2) (D-046). */
export const SNAP_DEFERRED_COUNT_BITS = 6;
export const SNAP_DEFERRED_ID_BITS = 16;
/**
 * What leaving out a reused slot costs (a new player in a slot whose baseline still holds the one
 * who left): it is sent as a removal, so the departed player disappears on time (D-046).
 */
export const SNAP_REUSED_OUT_BITS = ENTITY_REMOVED_BITS;

/**
 * The most players whose every snapshot fits SNAP_BUDGET_BITS without a scheduler (D-034): the
 * worst delta of the M3 design §2.1 size bounds is 312 + 233 bits per other player, so 36 others
 * fit (8700 bits, 1088 B) and 37 do not, as long as baseline and current frame together hold at
 * most this many players. Until the D-046 byte-budget scheduler a match admits at most this many
 * (`sv_maxClients` is clamped to it). The full form is smaller. Both checked below.
 */
export const SNAP_FIT_MAX_PLAYERS = 37;

if (
  SNAP_FULL_FIXED_BITS + (SNAP_FIT_MAX_PLAYERS - 1) * ENTITY_NEW_BITS > SNAP_BUDGET_BITS ||
  SNAP_DELTA_FIXED_BITS + (SNAP_FIT_MAX_PLAYERS - 1) * ENTITY_DELTA_MAX_BITS > SNAP_BUDGET_BITS ||
  SNAP_DELTA_FIXED_BITS + SNAP_FIT_MAX_PLAYERS * ENTITY_DELTA_MAX_BITS <= SNAP_BUDGET_BITS
) {
  throw new Error("snapshot layout: SNAP_FIT_MAX_PLAYERS is not the most whose worst case fits");
}

/**
 * The fewest records the byte-budget scheduler fits in any delta snapshot, whatever else it holds
 * (M3 design §2.3, D-046; derived, 34): every other slot costs at most 17 bits when it is left out
 * (a removal, a reused slot sent as removed, a deferred id), and a record at most 216 more, after
 * the fixed bits and the deferred count. With 63 other players and none of them free, ⌊(8800 −
 * 318 − 63 × 17) / (233 − 17)⌋ = 34.
 */
export const SNAP_MIN_CAPACITY = Math.floor(
  (SNAP_BUDGET_BITS -
    SNAP_DELTA_FIXED_BITS -
    SNAP_DEFERRED_COUNT_BITS -
    (MATCH_MAX_CLIENTS - 1) * ENTITY_REMOVED_BITS) /
    (ENTITY_DELTA_MAX_BITS - ENTITY_REMOVED_BITS),
);
/** The same for a full snapshot, every record a new body (37). */
export const SNAP_MIN_CAPACITY_FULL = Math.floor(
  (SNAP_BUDGET_BITS -
    SNAP_FULL_FIXED_BITS -
    SNAP_DEFERRED_COUNT_BITS -
    (MATCH_MAX_CLIENTS - 1) * ENTITY_REMOVED_BITS) /
    (ENTITY_NEW_BITS - ENTITY_REMOVED_BITS),
);
/**
 * The most ticks a remote's freshest state in a client's sent stream may lag the snapshot
 * (D-046): the scheduler includes every player left out last tick first, and since at least
 * SNAP_MIN_CAPACITY records fit, at most 63 − 34 = 29 are ever left out, which always fit the next
 * snapshot. So nobody is left out two ticks in a row.
 */
export const SNAP_MAX_STALENESS = 2;

// The bound holds only while two snapshots carry every other player: a cap or layout change that
// breaks it fails here, at load.
if (
  SNAP_DEFERRED_ID_BITS > ENTITY_REMOVED_BITS ||
  SNAP_REUSED_OUT_BITS > ENTITY_REMOVED_BITS ||
  2 * SNAP_MIN_CAPACITY < MATCH_MAX_CLIENTS - 1 ||
  2 * SNAP_MIN_CAPACITY_FULL < MATCH_MAX_CLIENTS - 1 ||
  (1 << SNAP_DEFERRED_COUNT_BITS) - 1 < MATCH_MAX_CLIENTS - 1
) {
  throw new Error("snapshot layout: the byte-budget scheduler's staleness bound does not hold");
}

/** The fields before the local block, and `teleportSeq` (decode only: the own slot's, D-035). */
export class SnapshotHeader {
  serverTick = 0;
  /** serverTick − the baseline's tick: 0 = full, 1–63 = a delta (D-038). */
  baseBack = 0;
  /** SNAP_FLAG_* bits. */
  flags = 0;
  /** Low 16 bits of the replicated cvar hash the tick was simulated with. */
  cvarHash = 0;
  /** Newest received cmd tick − the tick simulated, clamped to i8 (docs/05 §8.2). */
  inputBufferHealth = 0;
  /**
   * The receiver's teleport counter. The encoder writes the own slot's `teleportSeq`; the decoder
   * sets this and the own slot's to what it read.
   */
  teleportSeq = 0;
  /** Decode only: the ids the body's deferred list held (D-046; the encoder derives its own). */
  deferred = 0;
}

const ORIGIN_BITS = 21;
const ORIGIN_Q_MAX = ORIGIN_LIMIT * ORIGIN_SCALE;
const LOCAL_VELOCITY_BITS = 20;
/** The i20 maximum; −2^19 is representable but outside the quantizer's clamp. */
const LOCAL_VELOCITY_Q_MAX = 524287;
const ENTITY_VELOCITY_BITS = 16;
const EVENT_KIND_BITS = 4;
const GROUND1_MAX = ENTITY_WORLD + 1;
const SPECTATOR_MAX_BITS = MAX_SPECTATOR_SNAPSHOT_BYTES * 8;

/** Delta local block mask bits. */
const L_ORIGIN = 1 << 0;
const L_VELOCITY = 1 << 1;
const L_YAW = 1 << 2;
const L_PITCH = 1 << 3;
const L_FLAGS = 1 << 4;
const L_GROUND = 1 << 5;
const L_WATER = 1 << 6;
const L_STAMINA = 1 << 7;

/** Delta entity record mask bits. */
const E_ORIGIN = 1 << 0;
const E_VELOCITY = 1 << 1;
const E_YAW = 1 << 2;
const E_PITCH = 1 << 3;
const E_FLAGS = 1 << 4;
const E_TEAM = 1 << 5;
const E_TELEPORT = 1 << 6;
const E_EVENTS = 1 << 7;

/** A delta record before its fields: id, removed, new, mask. */
const ENTITY_DELTA_FIXED_BITS = 26;
const EVENTS_BITS = 8 + ENTITY_EVENT_SLOTS * (EVENT_KIND_BITS + 8);

/** What a slot needs in a snapshot: nothing, a removal, a full body or a delta body. */
const REC_NONE = 0;
const REC_REMOVED = 1;
const REC_NEW = 2;
const REC_DELTA = 3;
/** Left out by the scheduler (D-046): listed by id after the records. */
const REC_DEFERRED = 4;

/**
 * readAxis's refusal: a non-minimal class. It is outside every axis range, so the range check
 * that follows each read refuses it, and a small integer (no boxing).
 */
const AXIS_BAD = -0x40000000;

/** The local block goes through the PlayerState codec (docs/05 §3.6), via this scratch. */
const scratch = new PlayerState();
/**
 * The encoder's per-slot record kinds (REC_*) between its two passes, and the delta masks
 * `recordKind` leaves for the encoder and `entityRecordBits`.
 */
const recordKinds = new Uint8Array(FRAME_SLOTS);
const recordMasks = new Uint8Array(FRAME_SLOTS);
/** The decoder's per-slot marks: 0 unlisted, LISTED_RECORD, LISTED_DEFERRED. */
const listed = new Uint8Array(FRAME_SLOTS);
const LISTED_RECORD = 1;
const LISTED_DEFERRED = 2;

/** Whether an entity's two event slots are canonical (kinds 0–3, empty slots last and zero). */
function eventsValid(k0: number, v0: number, k1: number, v1: number): boolean {
  if (k0 > PMEV_LAND || k1 > PMEV_LAND) return false;
  if (k0 === PMEV_NONE && (v0 !== 0 || k1 !== PMEV_NONE)) return false;
  if (k1 === PMEV_NONE && v1 !== 0) return false;
  return (k0 !== PMEV_JUMP || v0 === 0) && (k1 !== PMEV_JUMP || v1 === 0);
}

function originInRange(q: number): boolean {
  return q <= ORIGIN_Q_MAX && q >= -ORIGIN_Q_MAX;
}

function pitchInRange(p: number): boolean {
  return p <= PITCH_LIMIT_U16 && p >= -PITCH_LIMIT_U16;
}

function fitsSigned(d: number, bits: number): boolean {
  const half = 1 << (bits - 1);
  return d >= -half && d < half;
}

function axisClass(d: number, b1: number, b2: number): number {
  if (d === 0) return 0;
  if (fitsSigned(d, b1)) return 1;
  return fitsSigned(d, b2) ? 2 : 3;
}

function axisBits(cur: number, base: number, b1: number, b2: number, b3: number): number {
  const c = axisClass(cur - base, b1, b2);
  if (c === 0) return 2;
  if (c === 1) return 2 + b1;
  return c === 2 ? 2 + b2 : 2 + b3;
}

function writeAxis(
  w: BitWriter,
  cur: number,
  base: number,
  b1: number,
  b2: number,
  b3: number,
): void {
  const d = cur - base;
  const c = axisClass(d, b1, b2);
  w.writeBits(c, 2);
  if (c === 1) w.writeSigned(d, b1);
  else if (c === 2) w.writeSigned(d, b2);
  else if (c === 3) w.writeSigned(cur, b3);
}

/** An axis against `base`, or AXIS_BAD when its class is not the smallest one. */
function readAxis(r: BitReader, base: number, b1: number, b2: number, b3: number): number {
  const c = r.readBits(2);
  if (c === 0) return base;
  if (c === 1) {
    const d = r.readSigned(b1);
    return d === 0 ? AXIS_BAD : base + d;
  }
  if (c === 2) {
    const d = r.readSigned(b2);
    return fitsSigned(d, b1) ? AXIS_BAD : base + d;
  }
  const v = r.readSigned(b3);
  return fitsSigned(v - base, b2) ? AXIS_BAD : v;
}

/** Which local-block fields of slot `s` differ between `cur` and `base` (L_* bits). */
function localMask(cur: WorldFrame, base: WorldFrame, s: number): number {
  let m = 0;
  if (
    cur.originX[s] !== base.originX[s] ||
    cur.originY[s] !== base.originY[s] ||
    cur.originZ[s] !== base.originZ[s]
  ) {
    m |= L_ORIGIN;
  }
  if (
    cur.vel16X[s] !== base.vel16X[s] ||
    cur.vel16Y[s] !== base.vel16Y[s] ||
    cur.vel16Z[s] !== base.vel16Z[s]
  ) {
    m |= L_VELOCITY;
  }
  if (cur.yaw[s] !== base.yaw[s]) m |= L_YAW;
  if (cur.pitch[s] !== base.pitch[s]) m |= L_PITCH;
  if (cur.flags[s] !== base.flags[s]) m |= L_FLAGS;
  if (cur.ground1[s] !== base.ground1[s]) m |= L_GROUND;
  if (cur.waterLevel[s] !== base.waterLevel[s]) m |= L_WATER;
  if (cur.stamina[s] !== base.stamina[s]) m |= L_STAMINA;
  return m;
}

/** Which entity fields of slot `s` differ between `cur` and `base` (E_* bits). */
function entityMask(cur: WorldFrame, base: WorldFrame, s: number): number {
  let m = 0;
  if (
    cur.originX[s] !== base.originX[s] ||
    cur.originY[s] !== base.originY[s] ||
    cur.originZ[s] !== base.originZ[s]
  ) {
    m |= E_ORIGIN;
  }
  if (
    cur.entVelX[s] !== base.entVelX[s] ||
    cur.entVelY[s] !== base.entVelY[s] ||
    cur.entVelZ[s] !== base.entVelZ[s]
  ) {
    m |= E_VELOCITY;
  }
  if (cur.yaw[s] !== base.yaw[s]) m |= E_YAW;
  if (cur.pitch[s] !== base.pitch[s]) m |= E_PITCH;
  if (
    ((cur.flags[s] as number) & ENTITY_FLAG_MASK) !==
    ((base.flags[s] as number) & ENTITY_FLAG_MASK)
  ) {
    m |= E_FLAGS;
  }
  if (cur.team[s] !== base.team[s]) m |= E_TEAM;
  if (cur.teleportSeq[s] !== base.teleportSeq[s]) m |= E_TELEPORT;
  const e = s * ENTITY_EVENT_SLOTS;
  if (
    cur.eventSeq[s] !== base.eventSeq[s] ||
    cur.evKind[e] !== base.evKind[e] ||
    cur.evValue[e] !== base.evValue[e] ||
    cur.evKind[e + 1] !== base.evKind[e + 1] ||
    cur.evValue[e + 1] !== base.evValue[e + 1]
  ) {
    m |= E_EVENTS;
  }
  return m;
}

/** Whether `base` holds state for slot `s` (present and not pending). */
function hasState(base: WorldFrame, s: number): boolean {
  return base.present[s] === 1 && base.stamp[s] !== 0;
}

/**
 * What slot `s` needs: a removal when it left since the baseline, a full body when the baseline
 * has no state for it or another incarnation (a different server serial), a delta body when an
 * entity field changed, else nothing. Every slot is new in a full snapshot (`base` null).
 */
function recordKind(cur: WorldFrame, base: WorldFrame | null, s: number): number {
  if (cur.present[s] !== 1) return base !== null && base.present[s] === 1 ? REC_REMOVED : REC_NONE;
  if (base === null || !hasState(base, s) || base.serial[s] !== cur.serial[s]) return REC_NEW;
  // The mask is kept for the caller, so a delta body's fields are compared once.
  const m = entityMask(cur, base, s);
  recordMasks[s] = m;
  return m === 0 ? REC_NONE : REC_DELTA;
}

/**
 * The exact bits of slot `s`'s entity record in a snapshot of `cur` against `base` (null: full),
 * as the encoder would write it, without writing: 0 when it needs none (M3 design §2.3; the D-046
 * scheduler sizes records with it).
 */
export function entityRecordBits(cur: WorldFrame, base: WorldFrame | null, s: number): number {
  const kind = recordKind(cur, base, s);
  if (kind === REC_NONE) return 0;
  if (kind === REC_REMOVED) return ENTITY_REMOVED_BITS;
  if (kind === REC_NEW || base === null) return ENTITY_NEW_BITS;
  const m = recordMasks[s] as number;
  let bits = ENTITY_DELTA_FIXED_BITS;
  if ((m & E_ORIGIN) !== 0) {
    bits +=
      axisBits(
        cur.originX[s] as number,
        base.originX[s] as number,
        SNAP_ORIGIN_D1,
        SNAP_ORIGIN_D2,
        ORIGIN_BITS,
      ) +
      axisBits(
        cur.originY[s] as number,
        base.originY[s] as number,
        SNAP_ORIGIN_D1,
        SNAP_ORIGIN_D2,
        ORIGIN_BITS,
      ) +
      axisBits(
        cur.originZ[s] as number,
        base.originZ[s] as number,
        SNAP_ORIGIN_D1,
        SNAP_ORIGIN_D2,
        ORIGIN_BITS,
      );
  }
  if ((m & E_VELOCITY) !== 0) {
    bits +=
      axisBits(
        cur.entVelX[s] as number,
        base.entVelX[s] as number,
        SNAP_ENTITY_VELOCITY_D1,
        SNAP_ENTITY_VELOCITY_D2,
        ENTITY_VELOCITY_BITS,
      ) +
      axisBits(
        cur.entVelY[s] as number,
        base.entVelY[s] as number,
        SNAP_ENTITY_VELOCITY_D1,
        SNAP_ENTITY_VELOCITY_D2,
        ENTITY_VELOCITY_BITS,
      ) +
      axisBits(
        cur.entVelZ[s] as number,
        base.entVelZ[s] as number,
        SNAP_ENTITY_VELOCITY_D1,
        SNAP_ENTITY_VELOCITY_D2,
        ENTITY_VELOCITY_BITS,
      );
  }
  if ((m & E_YAW) !== 0) bits += 16;
  if ((m & E_PITCH) !== 0) bits += 16;
  if ((m & E_FLAGS) !== 0) bits += 10;
  if ((m & E_TEAM) !== 0) bits += 2;
  if ((m & E_TELEPORT) !== 0) bits += 8;
  if ((m & E_EVENTS) !== 0) bits += EVENTS_BITS;
  return bits;
}

/**
 * The exact bits of receiver `selfId`'s local block in a snapshot of `cur` against `base` (null:
 * the full PlayerState), without writing.
 */
export function localBlockBits(cur: WorldFrame, base: WorldFrame | null, selfId: number): number {
  if (base === null) return PLAYER_STATE_BITS;
  const s = selfId;
  const m = localMask(cur, base, s);
  let bits = 8;
  if ((m & L_ORIGIN) !== 0) {
    bits +=
      axisBits(
        cur.originX[s] as number,
        base.originX[s] as number,
        SNAP_ORIGIN_D1,
        SNAP_ORIGIN_D2,
        ORIGIN_BITS,
      ) +
      axisBits(
        cur.originY[s] as number,
        base.originY[s] as number,
        SNAP_ORIGIN_D1,
        SNAP_ORIGIN_D2,
        ORIGIN_BITS,
      ) +
      axisBits(
        cur.originZ[s] as number,
        base.originZ[s] as number,
        SNAP_ORIGIN_D1,
        SNAP_ORIGIN_D2,
        ORIGIN_BITS,
      );
  }
  if ((m & L_VELOCITY) !== 0) {
    bits +=
      axisBits(
        cur.vel16X[s] as number,
        base.vel16X[s] as number,
        SNAP_LOCAL_VELOCITY_D1,
        SNAP_LOCAL_VELOCITY_D2,
        LOCAL_VELOCITY_BITS,
      ) +
      axisBits(
        cur.vel16Y[s] as number,
        base.vel16Y[s] as number,
        SNAP_LOCAL_VELOCITY_D1,
        SNAP_LOCAL_VELOCITY_D2,
        LOCAL_VELOCITY_BITS,
      ) +
      axisBits(
        cur.vel16Z[s] as number,
        base.vel16Z[s] as number,
        SNAP_LOCAL_VELOCITY_D1,
        SNAP_LOCAL_VELOCITY_D2,
        LOCAL_VELOCITY_BITS,
      );
  }
  if ((m & L_YAW) !== 0) bits += 16;
  if ((m & L_PITCH) !== 0) bits += 16;
  if ((m & L_FLAGS) !== 0) bits += 10;
  if ((m & L_GROUND) !== 0) bits += 16;
  if ((m & L_WATER) !== 0) bits += 2;
  if ((m & L_STAMINA) !== 0) bits += 16;
  return bits;
}

function writeOrigin(w: BitWriter, q: number): void {
  if (!originInRange(q)) w.fail();
  w.writeSigned(q, ORIGIN_BITS);
}

function writeEntityVelocity(w: BitWriter, q: number): void {
  if (q < -ENTITY_VELOCITY_MAX) w.fail();
  w.writeSigned(q, ENTITY_VELOCITY_BITS);
}

/** Slot `s`'s two events, after checking they are canonical. */
function writeEvents(w: BitWriter, f: WorldFrame, s: number): void {
  w.writeBits(f.eventSeq[s] as number, 8);
  const e = s * ENTITY_EVENT_SLOTS;
  const k0 = f.evKind[e] as number;
  const v0 = f.evValue[e] as number;
  const k1 = f.evKind[e + 1] as number;
  const v1 = f.evValue[e + 1] as number;
  if (!eventsValid(k0, v0, k1, v1)) w.fail();
  w.writeBits(k0, EVENT_KIND_BITS);
  w.writeBits(v0, 8);
  w.writeBits(k1, EVENT_KIND_BITS);
  w.writeBits(v1, 8);
}

function writePitch(w: BitWriter, pitch: number): void {
  if (!pitchInRange(pitch)) w.fail();
  w.writeBits(pitch & 0xffff, 16);
}

function writeTeam(w: BitWriter, team: number): void {
  if (team > TEAM_2) w.fail();
  w.writeBits(team, 2);
}

/** Slot `s` of `f` as a full ("new") record. */
function writeNewRecord(w: BitWriter, f: WorldFrame, s: number): void {
  w.writeBits(s, 16);
  w.writeBits(0, 1);
  w.writeBits(1, 1);
  writeOrigin(w, f.originX[s] as number);
  writeOrigin(w, f.originY[s] as number);
  writeOrigin(w, f.originZ[s] as number);
  writeEntityVelocity(w, f.entVelX[s] as number);
  writeEntityVelocity(w, f.entVelY[s] as number);
  writeEntityVelocity(w, f.entVelZ[s] as number);
  w.writeBits(f.yaw[s] as number, 16);
  writePitch(w, f.pitch[s] as number);
  w.writeBits((f.flags[s] as number) & ENTITY_FLAG_MASK, 10);
  writeTeam(w, f.team[s] as number);
  w.writeBits(f.teleportSeq[s] as number, 8);
  writeEvents(w, f, s);
}

/** Slot `s` as a delta record against `base`: the fields of `m` (E_* bits, never 0). */
function writeDeltaRecord(
  w: BitWriter,
  cur: WorldFrame,
  base: WorldFrame,
  s: number,
  m: number,
): void {
  w.writeBits(s, 16);
  w.writeBits(0, 1);
  w.writeBits(0, 1);
  w.writeBits(m, 8);
  if ((m & E_ORIGIN) !== 0) {
    const x = cur.originX[s] as number;
    const y = cur.originY[s] as number;
    const z = cur.originZ[s] as number;
    if (!originInRange(x) || !originInRange(y) || !originInRange(z)) w.fail();
    writeAxis(w, x, base.originX[s] as number, SNAP_ORIGIN_D1, SNAP_ORIGIN_D2, ORIGIN_BITS);
    writeAxis(w, y, base.originY[s] as number, SNAP_ORIGIN_D1, SNAP_ORIGIN_D2, ORIGIN_BITS);
    writeAxis(w, z, base.originZ[s] as number, SNAP_ORIGIN_D1, SNAP_ORIGIN_D2, ORIGIN_BITS);
  }
  if ((m & E_VELOCITY) !== 0) {
    const x = cur.entVelX[s] as number;
    const y = cur.entVelY[s] as number;
    const z = cur.entVelZ[s] as number;
    if (x < -ENTITY_VELOCITY_MAX || y < -ENTITY_VELOCITY_MAX || z < -ENTITY_VELOCITY_MAX) w.fail();
    const d1 = SNAP_ENTITY_VELOCITY_D1;
    const d2 = SNAP_ENTITY_VELOCITY_D2;
    writeAxis(w, x, base.entVelX[s] as number, d1, d2, ENTITY_VELOCITY_BITS);
    writeAxis(w, y, base.entVelY[s] as number, d1, d2, ENTITY_VELOCITY_BITS);
    writeAxis(w, z, base.entVelZ[s] as number, d1, d2, ENTITY_VELOCITY_BITS);
  }
  if ((m & E_YAW) !== 0) w.writeBits(cur.yaw[s] as number, 16);
  if ((m & E_PITCH) !== 0) writePitch(w, cur.pitch[s] as number);
  if ((m & E_FLAGS) !== 0) w.writeBits((cur.flags[s] as number) & ENTITY_FLAG_MASK, 10);
  if ((m & E_TEAM) !== 0) writeTeam(w, cur.team[s] as number);
  if ((m & E_TELEPORT) !== 0) w.writeBits(cur.teleportSeq[s] as number, 8);
  if ((m & E_EVENTS) !== 0) writeEvents(w, cur, s);
}

/** Receiver slot `s` as a delta local block against `base`'s. */
function writeLocalDelta(w: BitWriter, cur: WorldFrame, base: WorldFrame, s: number): void {
  // What the full block would refuse (encodePlayerState), whether or not the field changed.
  const ox = cur.originX[s] as number;
  const oy = cur.originY[s] as number;
  const oz = cur.originZ[s] as number;
  const vx = cur.vel16X[s] as number;
  const vy = cur.vel16Y[s] as number;
  const vz = cur.vel16Z[s] as number;
  if (
    !originInRange(ox) ||
    !originInRange(oy) ||
    !originInRange(oz) ||
    vx > LOCAL_VELOCITY_Q_MAX ||
    vx < -LOCAL_VELOCITY_Q_MAX ||
    vy > LOCAL_VELOCITY_Q_MAX ||
    vy < -LOCAL_VELOCITY_Q_MAX ||
    vz > LOCAL_VELOCITY_Q_MAX ||
    vz < -LOCAL_VELOCITY_Q_MAX ||
    !pitchInRange(cur.pitch[s] as number) ||
    (cur.flags[s] as number) > 0x3ff ||
    (cur.ground1[s] as number) > GROUND1_MAX ||
    (cur.waterLevel[s] as number) > 3
  ) {
    w.fail();
    return;
  }
  const m = localMask(cur, base, s);
  w.writeBits(m, 8);
  if ((m & L_ORIGIN) !== 0) {
    writeAxis(w, ox, base.originX[s] as number, SNAP_ORIGIN_D1, SNAP_ORIGIN_D2, ORIGIN_BITS);
    writeAxis(w, oy, base.originY[s] as number, SNAP_ORIGIN_D1, SNAP_ORIGIN_D2, ORIGIN_BITS);
    writeAxis(w, oz, base.originZ[s] as number, SNAP_ORIGIN_D1, SNAP_ORIGIN_D2, ORIGIN_BITS);
  }
  if ((m & L_VELOCITY) !== 0) {
    const d1 = SNAP_LOCAL_VELOCITY_D1;
    const d2 = SNAP_LOCAL_VELOCITY_D2;
    writeAxis(w, vx, base.vel16X[s] as number, d1, d2, LOCAL_VELOCITY_BITS);
    writeAxis(w, vy, base.vel16Y[s] as number, d1, d2, LOCAL_VELOCITY_BITS);
    writeAxis(w, vz, base.vel16Z[s] as number, d1, d2, LOCAL_VELOCITY_BITS);
  }
  if ((m & L_YAW) !== 0) w.writeBits(cur.yaw[s] as number, 16);
  if ((m & L_PITCH) !== 0) w.writeBits((cur.pitch[s] as number) & 0xffff, 16);
  if ((m & L_FLAGS) !== 0) w.writeBits(cur.flags[s] as number, 10);
  if ((m & L_GROUND) !== 0) w.writeBits(cur.ground1[s] as number, 16);
  if ((m & L_WATER) !== 0) w.writeBits(cur.waterLevel[s] as number, 2);
  if ((m & L_STAMINA) !== 0) w.writeBits(cur.stamina[s] as number, 16);
}

/**
 * Whether present slot `s` of `cur`, whose stamp is not the tick, may be left out against `base`
 * (D-046): a pending slot only where the receiver holds no state for it (a full snapshot, or a
 * baseline slot absent or pending), a slot with older state only as an exact copy of the
 * baseline's (same stamp, incarnation and entity fields), which is what the receiver keeps.
 */
function deferrable(cur: WorldFrame, base: WorldFrame | null, s: number): boolean {
  const st = cur.stamp[s] as number;
  if (st === 0) return base === null || !hasState(base, s);
  return (
    base !== null &&
    hasState(base, s) &&
    base.stamp[s] === st &&
    base.serial[s] === cur.serial[s] &&
    entityMask(cur, base, s) === 0
  );
}

/**
 * Encodes the snapshot of tick `hdr.serverTick` for receiver `selfId` from frame `cur`: its own
 * slot as the local block, every other slot that needs one as a record. `base` null is a full
 * snapshot (`hdr.baseBack` 0); otherwise `base` is the frame of tick serverTick − `hdr.baseBack`
 * (1–63, the tick ≥ 1) as the receiver holds it, and the snapshot is a delta against it. A present
 * slot whose stamp is not the tick was left out by the scheduler (D-046) and goes in the deferred
 * list; the encoder sets SNAP_FLAG_DEFERRED exactly when that list is not empty (the caller's bit
 * is ignored). With SNAP_FLAG_SPECTATOR there is no receiver and every slot is a record. Returns
 * false (the writer's error flag) on anything the layout can't carry: a receiver absent from `cur`
 * (or without state in `base`), a left-out slot the receiver would not rebuild (`deferrable`), a
 * left-out slot in a spectator snapshot, a value out of range, or a live snapshot over
 * MAX_SNAPSHOT_BYTES.
 */
export function encodeSnapshot(
  w: BitWriter,
  hdr: SnapshotHeader,
  cur: WorldFrame,
  base: WorldFrame | null,
  selfId: number,
): boolean {
  const spectator = (hdr.flags & SNAP_FLAG_SPECTATOR) !== 0;
  const t = hdr.serverTick;
  const back = hdr.baseBack;
  if (t < 1) w.fail();
  if (
    base === null ? back !== 0 : back < 1 || back >= SNAPSHOT_HISTORY || back >= t || base === cur
  ) {
    w.fail();
  }
  const self = spectator ? -1 : selfId;
  if (!spectator && !(selfId >= 0 && selfId < FRAME_SLOTS)) {
    w.fail();
    return false;
  }
  // One pass classifies (the flags and the count lead the records), the second writes from it.
  const kinds = recordKinds;
  const masks = recordMasks;
  let count = 0;
  let deferred = 0;
  for (let s = 0; s < FRAME_SLOTS; s++) {
    if (s === self) {
      kinds[s] = REC_NONE;
      continue;
    }
    if (cur.present[s] === 1 && cur.stamp[s] !== t) {
      if (spectator || !deferrable(cur, base, s)) w.fail();
      kinds[s] = REC_DEFERRED;
      deferred++;
      continue;
    }
    const kind = recordKind(cur, base, s);
    kinds[s] = kind;
    if (kind === REC_NONE) continue;
    count++;
  }
  const flags = (hdr.flags & ~SNAP_FLAG_DEFERRED) | (deferred > 0 ? SNAP_FLAG_DEFERRED : 0);
  if ((flags & ~SNAP_FLAG_MASK) !== 0 || (spectator && (flags & SNAP_FLAG_STARVED) !== 0)) {
    w.fail();
  }
  w.writeBits(MSG_SNAPSHOT, 8);
  writeTick(w, t);
  w.writeBits(back, 6);
  w.writeBits(flags, 8);
  w.writeBits(hdr.cvarHash, 16);
  if (!spectator) {
    if (cur.present[selfId] !== 1) {
      w.fail();
      return false;
    }
    if (cur.stamp[selfId] !== t) w.fail();
    w.writeSigned(hdr.inputBufferHealth, 8);
    w.writeBits(cur.teleportSeq[selfId] as number, 8);
    if (base === null) {
      slotToPlayerState(cur, selfId, scratch);
      encodePlayerState(w, scratch);
    } else if (!hasState(base, selfId)) {
      w.fail();
      return false;
    } else {
      writeLocalDelta(w, cur, base, selfId);
    }
  }
  w.writeBits(count, SNAP_ENTITY_COUNT_BITS);
  for (let s = 0; s < FRAME_SLOTS; s++) {
    const kind = kinds[s];
    if (kind === REC_NEW) {
      writeNewRecord(w, cur, s);
    } else if (kind === REC_REMOVED) {
      w.writeBits(s, 16);
      w.writeBits(1, 1);
    } else if (kind === REC_DELTA && base !== null) {
      writeDeltaRecord(w, cur, base, s, masks[s] as number);
    }
  }
  if (deferred > 0) {
    w.writeBits(deferred, SNAP_DEFERRED_COUNT_BITS);
    for (let s = 0; s < FRAME_SLOTS; s++) {
      if (kinds[s] === REC_DEFERRED) w.writeBits(s, SNAP_DEFERRED_ID_BITS);
    }
  }
  if (w.bitLength > (spectator ? SPECTATOR_MAX_BITS : SNAP_BUDGET_BITS)) w.fail();
  return !w.error;
}

/**
 * Reads the fields before the local block (and health and teleportSeq) into `out`. False on a
 * short read, a tick of 0 or past TICK_MAX, a baseline before tick 1 (baseBack ≥ serverTick), or
 * flags the protocol refuses (bit 1, bits 4–7, SPECTATOR with STARVED or DEFERRED). `out` is then
 * partial.
 */
export function decodeSnapshotHeader(r: BitReader, out: SnapshotHeader): boolean {
  if (r.readBits(8) !== MSG_SNAPSHOT) return false;
  const t = readTick(r);
  const baseBack = r.readBits(6);
  const flags = r.readBits(8);
  const cvarHash = r.readBits(16);
  const spectator = (flags & SNAP_FLAG_SPECTATOR) !== 0;
  if (t < 1 || baseBack >= t || (flags & ~SNAP_FLAG_MASK) !== 0) return false;
  if (spectator && (flags & (SNAP_FLAG_STARVED | SNAP_FLAG_DEFERRED)) !== 0) return false;
  out.serverTick = t;
  out.baseBack = baseBack;
  out.flags = flags;
  out.cvarHash = cvarHash;
  out.deferred = 0;
  if (spectator) {
    out.inputBufferHealth = 0;
    out.teleportSeq = 0;
  } else {
    out.inputBufferHealth = r.readSigned(8);
    out.teleportSeq = r.readBits(8);
  }
  return !r.error;
}

/**
 * Slot `s` of `out` at tick `t` with `base`'s entity state, as a client holds a remote: flags
 * masked, the local-block-only fields 0 (they are not on the wire), the baseline's serial.
 */
function copyEntity(out: WorldFrame, s: number, base: WorldFrame, t: number): void {
  out.setPresent(s, t);
  out.serial[s] = base.serial[s] as number;
  out.originX[s] = base.originX[s] as number;
  out.originY[s] = base.originY[s] as number;
  out.originZ[s] = base.originZ[s] as number;
  out.vel16X[s] = 0;
  out.vel16Y[s] = 0;
  out.vel16Z[s] = 0;
  out.ground1[s] = 0;
  out.waterLevel[s] = 0;
  out.stamina[s] = 0;
  out.entVelX[s] = base.entVelX[s] as number;
  out.entVelY[s] = base.entVelY[s] as number;
  out.entVelZ[s] = base.entVelZ[s] as number;
  out.yaw[s] = base.yaw[s] as number;
  out.pitch[s] = base.pitch[s] as number;
  out.flags[s] = (base.flags[s] as number) & ENTITY_FLAG_MASK;
  out.team[s] = base.team[s] as number;
  out.teleportSeq[s] = base.teleportSeq[s] as number;
  out.eventSeq[s] = base.eventSeq[s] as number;
  const e = s * ENTITY_EVENT_SLOTS;
  out.evKind[e] = base.evKind[e] as number;
  out.evValue[e] = base.evValue[e] as number;
  out.evKind[e + 1] = base.evKind[e + 1] as number;
  out.evValue[e + 1] = base.evValue[e + 1] as number;
}

/**
 * Slot `s` as pending (present, no state yet; D-046): left out of a snapshot whose baseline holds
 * no state for it. Its fields are zeroed, so a frame's unused fields never depend on history.
 */
function setPending(out: WorldFrame, s: number): void {
  out.setPresent(s, 0);
  out.serial[s] = 0;
  out.originX[s] = 0;
  out.originY[s] = 0;
  out.originZ[s] = 0;
  out.vel16X[s] = 0;
  out.vel16Y[s] = 0;
  out.vel16Z[s] = 0;
  out.entVelX[s] = 0;
  out.entVelY[s] = 0;
  out.entVelZ[s] = 0;
  out.yaw[s] = 0;
  out.pitch[s] = 0;
  out.flags[s] = 0;
  out.ground1[s] = 0;
  out.waterLevel[s] = 0;
  out.stamina[s] = 0;
  out.team[s] = 0;
  out.teleportSeq[s] = 0;
  out.eventSeq[s] = 0;
  const e = s * ENTITY_EVENT_SLOTS;
  out.evKind[e] = 0;
  out.evValue[e] = 0;
  out.evKind[e + 1] = 0;
  out.evValue[e + 1] = 0;
}

/**
 * Every slot but the receiver's that no record listed: a deferred one keeps the baseline's state
 * and stamp, or turns pending where the baseline holds no state for it (or there is none); an
 * unlisted one the baseline holds is unchanged, copied with stamp `t`, and one the baseline holds
 * as pending would have needed a record or a deferral (the encoder never leaves it out), so it
 * refuses the packet; anything else stays absent.
 */
function finishUnlisted(
  base: WorldFrame | null,
  out: WorldFrame,
  self: number,
  t: number,
): boolean {
  for (let s = 0; s < FRAME_SLOTS; s++) {
    const mark = listed[s] as number;
    if (s === self || mark === LISTED_RECORD) continue;
    if (mark === LISTED_DEFERRED) {
      if (base !== null && hasState(base, s)) copyEntity(out, s, base, base.stamp[s] as number);
      else setPending(out, s);
      continue;
    }
    if (base === null || base.present[s] !== 1) continue;
    if (base.stamp[s] === 0) return false;
    copyEntity(out, s, base, t);
  }
  return true;
}

/** A full record's body for slot `id` at tick `t`; false on a value the encoder never writes. */
function readNewBody(r: BitReader, out: WorldFrame, id: number, t: number): boolean {
  const ox = r.readSigned(ORIGIN_BITS);
  const oy = r.readSigned(ORIGIN_BITS);
  const oz = r.readSigned(ORIGIN_BITS);
  const vx = r.readSigned(ENTITY_VELOCITY_BITS);
  const vy = r.readSigned(ENTITY_VELOCITY_BITS);
  const vz = r.readSigned(ENTITY_VELOCITY_BITS);
  const yaw = r.readBits(16);
  const pitch = toSigned16(r.readBits(16));
  const flags = r.readBits(10);
  const team = r.readBits(2);
  const teleportSeq = r.readBits(8);
  const eventSeq = r.readBits(8);
  const k0 = r.readBits(EVENT_KIND_BITS);
  const v0 = r.readBits(8);
  const k1 = r.readBits(EVENT_KIND_BITS);
  const v1 = r.readBits(8);
  if (
    r.error ||
    !originInRange(ox) ||
    !originInRange(oy) ||
    !originInRange(oz) ||
    vx < -ENTITY_VELOCITY_MAX ||
    vy < -ENTITY_VELOCITY_MAX ||
    vz < -ENTITY_VELOCITY_MAX ||
    !pitchInRange(pitch) ||
    (flags & ~ENTITY_FLAG_MASK) !== 0 ||
    team > TEAM_2 ||
    !eventsValid(k0, v0, k1, v1)
  ) {
    return false;
  }
  out.setPresent(id, t);
  out.serial[id] = 0;
  out.originX[id] = ox;
  out.originY[id] = oy;
  out.originZ[id] = oz;
  // A remote's local-block fields are not on the wire.
  out.vel16X[id] = 0;
  out.vel16Y[id] = 0;
  out.vel16Z[id] = 0;
  out.ground1[id] = 0;
  out.waterLevel[id] = 0;
  out.stamina[id] = 0;
  out.entVelX[id] = vx;
  out.entVelY[id] = vy;
  out.entVelZ[id] = vz;
  out.yaw[id] = yaw;
  out.pitch[id] = pitch;
  out.flags[id] = flags;
  out.team[id] = team;
  out.teleportSeq[id] = teleportSeq;
  out.eventSeq[id] = eventSeq;
  const e = id * ENTITY_EVENT_SLOTS;
  out.evKind[e] = k0;
  out.evValue[e] = v0;
  out.evKind[e + 1] = k1;
  out.evValue[e + 1] = v1;
  return true;
}

/**
 * A delta record's body for slot `id` (with state in `base`) at tick `t`; false on a mask of 0, a
 * non-minimal class, a set field or group equal to the baseline, or a value out of range.
 */
function readDeltaBody(
  r: BitReader,
  base: WorldFrame,
  out: WorldFrame,
  id: number,
  t: number,
): boolean {
  const m = r.readBits(8);
  const bx = base.originX[id] as number;
  const by = base.originY[id] as number;
  const bz = base.originZ[id] as number;
  let ox = bx;
  let oy = by;
  let oz = bz;
  if ((m & E_ORIGIN) !== 0) {
    ox = readAxis(r, bx, SNAP_ORIGIN_D1, SNAP_ORIGIN_D2, ORIGIN_BITS);
    oy = readAxis(r, by, SNAP_ORIGIN_D1, SNAP_ORIGIN_D2, ORIGIN_BITS);
    oz = readAxis(r, bz, SNAP_ORIGIN_D1, SNAP_ORIGIN_D2, ORIGIN_BITS);
    if (ox === bx && oy === by && oz === bz) return false;
    if (!originInRange(ox) || !originInRange(oy) || !originInRange(oz)) return false;
  }
  const bvx = base.entVelX[id] as number;
  const bvy = base.entVelY[id] as number;
  const bvz = base.entVelZ[id] as number;
  let vx = bvx;
  let vy = bvy;
  let vz = bvz;
  if ((m & E_VELOCITY) !== 0) {
    const d1 = SNAP_ENTITY_VELOCITY_D1;
    const d2 = SNAP_ENTITY_VELOCITY_D2;
    vx = readAxis(r, bvx, d1, d2, ENTITY_VELOCITY_BITS);
    vy = readAxis(r, bvy, d1, d2, ENTITY_VELOCITY_BITS);
    vz = readAxis(r, bvz, d1, d2, ENTITY_VELOCITY_BITS);
    if (vx === bvx && vy === bvy && vz === bvz) return false;
    const max = ENTITY_VELOCITY_MAX;
    if (vx < -max || vx > max || vy < -max || vy > max || vz < -max || vz > max) return false;
  }
  let yaw = base.yaw[id] as number;
  if ((m & E_YAW) !== 0) {
    const v = r.readBits(16);
    if (v === yaw) return false;
    yaw = v;
  }
  let pitch = base.pitch[id] as number;
  if ((m & E_PITCH) !== 0) {
    const v = toSigned16(r.readBits(16));
    if (v === pitch || !pitchInRange(v)) return false;
    pitch = v;
  }
  let flags = (base.flags[id] as number) & ENTITY_FLAG_MASK;
  if ((m & E_FLAGS) !== 0) {
    const v = r.readBits(10);
    if (v === flags || (v & ~ENTITY_FLAG_MASK) !== 0) return false;
    flags = v;
  }
  let team = base.team[id] as number;
  if ((m & E_TEAM) !== 0) {
    const v = r.readBits(2);
    if (v === team || v > TEAM_2) return false;
    team = v;
  }
  let teleportSeq = base.teleportSeq[id] as number;
  if ((m & E_TELEPORT) !== 0) {
    const v = r.readBits(8);
    if (v === teleportSeq) return false;
    teleportSeq = v;
  }
  const e = id * ENTITY_EVENT_SLOTS;
  let eventSeq = base.eventSeq[id] as number;
  let k0 = base.evKind[e] as number;
  let v0 = base.evValue[e] as number;
  let k1 = base.evKind[e + 1] as number;
  let v1 = base.evValue[e + 1] as number;
  if ((m & E_EVENTS) !== 0) {
    const seq = r.readBits(8);
    const nk0 = r.readBits(EVENT_KIND_BITS);
    const nv0 = r.readBits(8);
    const nk1 = r.readBits(EVENT_KIND_BITS);
    const nv1 = r.readBits(8);
    if (seq === eventSeq && nk0 === k0 && nv0 === v0 && nk1 === k1 && nv1 === v1) return false;
    if (!eventsValid(nk0, nv0, nk1, nv1)) return false;
    eventSeq = seq;
    k0 = nk0;
    v0 = nv0;
    k1 = nk1;
    v1 = nv1;
  }
  if (m === 0 || r.error) return false;
  copyEntity(out, id, base, t);
  out.originX[id] = ox;
  out.originY[id] = oy;
  out.originZ[id] = oz;
  out.entVelX[id] = vx;
  out.entVelY[id] = vy;
  out.entVelZ[id] = vz;
  out.yaw[id] = yaw;
  out.pitch[id] = pitch;
  out.flags[id] = flags;
  out.team[id] = team;
  out.teleportSeq[id] = teleportSeq;
  out.eventSeq[id] = eventSeq;
  out.evKind[e] = k0;
  out.evValue[e] = v0;
  out.evKind[e + 1] = k1;
  out.evValue[e + 1] = v1;
  return true;
}

/**
 * A delta local block for receiver slot `s` against `base`'s (with state), into `out`'s slot
 * `s`; false on a non-minimal class, a set field or group equal to the baseline, or a value the
 * full block refuses.
 */
function readLocalDelta(r: BitReader, base: WorldFrame, out: WorldFrame, s: number): boolean {
  const m = r.readBits(8);
  const bx = base.originX[s] as number;
  const by = base.originY[s] as number;
  const bz = base.originZ[s] as number;
  let ox = bx;
  let oy = by;
  let oz = bz;
  if ((m & L_ORIGIN) !== 0) {
    ox = readAxis(r, bx, SNAP_ORIGIN_D1, SNAP_ORIGIN_D2, ORIGIN_BITS);
    oy = readAxis(r, by, SNAP_ORIGIN_D1, SNAP_ORIGIN_D2, ORIGIN_BITS);
    oz = readAxis(r, bz, SNAP_ORIGIN_D1, SNAP_ORIGIN_D2, ORIGIN_BITS);
    if (ox === bx && oy === by && oz === bz) return false;
    if (!originInRange(ox) || !originInRange(oy) || !originInRange(oz)) return false;
  }
  const bvx = base.vel16X[s] as number;
  const bvy = base.vel16Y[s] as number;
  const bvz = base.vel16Z[s] as number;
  let vx = bvx;
  let vy = bvy;
  let vz = bvz;
  if ((m & L_VELOCITY) !== 0) {
    const d1 = SNAP_LOCAL_VELOCITY_D1;
    const d2 = SNAP_LOCAL_VELOCITY_D2;
    vx = readAxis(r, bvx, d1, d2, LOCAL_VELOCITY_BITS);
    vy = readAxis(r, bvy, d1, d2, LOCAL_VELOCITY_BITS);
    vz = readAxis(r, bvz, d1, d2, LOCAL_VELOCITY_BITS);
    if (vx === bvx && vy === bvy && vz === bvz) return false;
    const max = LOCAL_VELOCITY_Q_MAX;
    if (vx < -max || vx > max || vy < -max || vy > max || vz < -max || vz > max) return false;
  }
  let yaw = base.yaw[s] as number;
  if ((m & L_YAW) !== 0) {
    const v = r.readBits(16);
    if (v === yaw) return false;
    yaw = v;
  }
  let pitch = base.pitch[s] as number;
  if ((m & L_PITCH) !== 0) {
    const v = toSigned16(r.readBits(16));
    if (v === pitch || !pitchInRange(v)) return false;
    pitch = v;
  }
  let flags = base.flags[s] as number;
  if ((m & L_FLAGS) !== 0) {
    const v = r.readBits(10);
    if (v === flags) return false;
    flags = v;
  }
  let ground1 = base.ground1[s] as number;
  if ((m & L_GROUND) !== 0) {
    const v = r.readBits(16);
    if (v === ground1 || v > GROUND1_MAX) return false;
    ground1 = v;
  }
  let waterLevel = base.waterLevel[s] as number;
  if ((m & L_WATER) !== 0) {
    const v = r.readBits(2);
    if (v === waterLevel) return false;
    waterLevel = v;
  }
  let stamina = base.stamina[s] as number;
  if ((m & L_STAMINA) !== 0) {
    const v = r.readBits(16);
    if (v === stamina) return false;
    stamina = v;
  }
  if (r.error) return false;
  out.originX[s] = ox;
  out.originY[s] = oy;
  out.originZ[s] = oz;
  out.vel16X[s] = vx;
  out.vel16Y[s] = vy;
  out.vel16Z[s] = vz;
  out.entVelX[s] = entityVelocity(vx);
  out.entVelY[s] = entityVelocity(vy);
  out.entVelZ[s] = entityVelocity(vz);
  out.yaw[s] = yaw;
  out.pitch[s] = pitch;
  out.flags[s] = flags;
  out.ground1[s] = ground1;
  out.waterLevel[s] = waterLevel;
  out.stamina[s] = stamina;
  return true;
}

/**
 * Reads the rest of a snapshot whose header `hdr` was just read into `out`, as receiver `selfId`
 * holds it. `base` is null for a full snapshot (`hdr.baseBack` 0), else the receiver's frame of
 * tick serverTick − `hdr.baseBack` (never `out` itself). The own slot comes from the local block
 * (present, stamp = the tick, teleportSeq from the header; team and events not carried), each
 * full or delta record's slot is present with stamp = the tick, an unlisted slot the baseline
 * holds is unchanged (copied, stamp = the tick), a removed or unlisted-and-not-held slot is absent,
 * a deferred slot (D-046) keeps the baseline's state and stamp or turns pending; `hdr.deferred` is
 * set to the number of deferred ids.
 * With SNAP_FLAG_SPECTATOR, `selfId` is ignored. A decoded slot's `serial` is the baseline's, + 1
 * for a "new" record over a slot the baseline holds and 0 for one it doesn't, so a re-encode
 * against the same baseline picks the same body forms (the client reads no serial otherwise).
 * False on anything the encoder never writes (ids not strictly ascending or ≥ 64, the receiver's
 * own id, a removal in a full snapshot or of a slot the baseline lacks, a delta record for a slot
 * without state in the baseline or in a full snapshot, a non-canonical delta, out-of-range fields,
 * too many records, a deferred list that is empty, unsorted, holds the own id, an id ≥ 64 or one
 * already listed as a record, a live snapshot over MAX_SNAPSHOT_BYTES, bits after the last byte);
 * `out` is then partial and must be dropped.
 */
export function decodeSnapshotBody(
  r: BitReader,
  hdr: SnapshotHeader,
  base: WorldFrame | null,
  selfId: number,
  out: WorldFrame,
): boolean {
  if ((hdr.baseBack === 0) !== (base === null) || out === base) return false;
  const spectator = (hdr.flags & SNAP_FLAG_SPECTATOR) !== 0;
  if (spectator && (hdr.flags & SNAP_FLAG_DEFERRED) !== 0) return false;
  const t = hdr.serverTick;
  const self = spectator ? -1 : selfId;
  out.clear();
  if (!spectator) {
    if (!(selfId >= 0 && selfId < FRAME_SLOTS)) return false;
    if (base === null) {
      if (!decodePlayerState(r, scratch)) return false;
      playerStateToSlot(out, selfId, scratch);
    } else if (!hasState(base, selfId) || !readLocalDelta(r, base, out, selfId)) {
      return false;
    }
    out.setPresent(selfId, t);
    out.serial[selfId] = 0;
    out.team[selfId] = 0;
    out.teleportSeq[selfId] = hdr.teleportSeq;
    out.eventSeq[selfId] = 0;
    const e = selfId * ENTITY_EVENT_SLOTS;
    out.evKind[e] = 0;
    out.evValue[e] = 0;
    out.evKind[e + 1] = 0;
    out.evValue[e + 1] = 0;
  }
  const count = r.readBits(SNAP_ENTITY_COUNT_BITS);
  if (count > (spectator ? FRAME_SLOTS : FRAME_SLOTS - 1)) return false;
  const marks = listed;
  marks.fill(0);
  let prev = -1;
  for (let i = 0; i < count; i++) {
    const id = r.readBits(16);
    if (id <= prev || id >= FRAME_SLOTS || id === self) return false;
    prev = id;
    marks[id] = LISTED_RECORD;
    if (r.readBits(1) === 1) {
      // A removal needs a baseline that holds the slot (pending included); the slot stays absent.
      if (base === null || base.present[id] !== 1) return false;
      continue;
    }
    if (r.readBits(1) === 1) {
      if (!readNewBody(r, out, id, t)) return false;
      if (base !== null && hasState(base, id)) {
        out.serial[id] = ((base.serial[id] as number) + 1) & 0xffff;
      }
    } else if (base === null || !hasState(base, id) || !readDeltaBody(r, base, out, id, t)) {
      return false;
    }
  }
  let deferred = 0;
  if ((hdr.flags & SNAP_FLAG_DEFERRED) !== 0) {
    deferred = r.readBits(SNAP_DEFERRED_COUNT_BITS);
    if (deferred === 0) return false;
    prev = -1;
    for (let i = 0; i < deferred; i++) {
      const id = r.readBits(SNAP_DEFERRED_ID_BITS);
      if (id <= prev || id >= FRAME_SLOTS || id === self || marks[id] !== 0) return false;
      prev = id;
      marks[id] = LISTED_DEFERRED;
    }
  }
  if (r.error || !finishUnlisted(base, out, self, t)) return false;
  hdr.deferred = deferred;
  if (r.bitPosition > (spectator ? SPECTATOR_MAX_BITS : SNAP_BUDGET_BITS)) return false;
  return r.atEnd();
}
