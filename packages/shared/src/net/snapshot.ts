import { PITCH_LIMIT_U16 } from "../math/angles";
import { ORIGIN_LIMIT, ORIGIN_SCALE, toSigned16 } from "../math/quant";
import { ENTITY_FLAG_MASK, TEAM_2 } from "../sim/entity";
import { PMEV_JUMP, PMEV_LAND, PMEV_NONE } from "../sim/events";
import { PlayerState } from "../sim/playerState";
import type { BitReader, BitWriter } from "./bitstream";
import { readTick, writeTick } from "./messages";
import { decodePlayerState, encodePlayerState, PLAYER_STATE_BITS } from "./playerStateCodec";
import {
  MAX_SPECTATOR_SNAPSHOT_BYTES,
  MSG_SNAPSHOT,
  SNAP_BUDGET_BITS,
  SNAP_FLAG_MASK,
  SNAP_FLAG_SPECTATOR,
  SNAP_FLAG_STARVED,
} from "./protocol";
import {
  ENTITY_EVENT_SLOTS,
  ENTITY_VELOCITY_MAX,
  FRAME_SLOTS,
  playerStateToSlot,
  slotToPlayerState,
  type WorldFrame,
} from "./worldFrame";

/**
 * SNAPSHOT, protocol v2 (docs/05 §3.6, M3 design §2.1, D-033): a header, the receiver's local
 * block, then an entity record per other present player (entity id = client id), ids ascending.
 * The server encodes from its world frame; the client decodes into a `WorldFrame` of its store.
 *
 * | Field | Bits |
 * |---|---|
 * | type | 8 (5) |
 * | serverTick | 32 (1…TICK_MAX) |
 * | baseBack | 6 (0 = full; deltas join with D-038 and are refused until then) |
 * | flags | 8 (SNAP_FLAG_*; bit 1 and bits 3–7 refused, SPECTATOR with STARVED refused) |
 * | cvarHash | 16 |
 * | inputBufferHealth | 8 (i8; not when spectator) |
 * | teleportSeq | 8 (not when spectator; D-035) |
 * | local block | the full PlayerState, 199 (not when spectator) |
 * | entityCount | 7 (0…63; 0…64 when spectator) |
 * | entity records | 213 each in a full snapshot |
 *
 * A full ("new") entity record: id 16 (< 64; the receiver's own refused unless spectator), removed
 * 1 (0: removal needs a baseline), new 1 (1), origin 3 × i21 (1/32 u, ±16384 u), velocity
 * 3 × i16 (1 u/s, ±32767), yaw 16, pitch 16 (±16201), flags 10 (within ENTITY_FLAG_MASK), team 2
 * (0–2), teleportSeq 8, eventSeq 8, two events of kind 4 (0 none, 1 STEP, 2 JUMP, 3 LAND) +
 * value 8 (0 when empty; JUMP's is 0; an empty first slot needs an empty second).
 *
 * Canonical: a packet the decoder accepts re-encodes to the same bytes (NET-01), and decoding
 * yields the frame it was encoded from, as the receiver holds it (frameDigest). A live snapshot is
 * at most MAX_SNAPSHOT_BYTES (the encoder refuses more, so the decoder does too); a spectator one
 * (demo files only) at most MAX_SPECTATOR_SNAPSHOT_BYTES. Neither side allocates, refusals
 * included.
 */

/** Header bits with the type byte (M3 design §2.1): 86, or 70 without health and teleportSeq. */
export const SNAP_HEADER_BITS = 86;
export const SNAP_SPECTATOR_HEADER_BITS = 70;
export const SNAP_ENTITY_COUNT_BITS = 7;
/** A full entity record, id, removed and new bits included. */
export const ENTITY_NEW_BITS = 213;
/** A full live snapshot with no other player: header, local block, entity count. */
export const SNAP_FULL_FIXED_BITS = SNAP_HEADER_BITS + PLAYER_STATE_BITS + SNAP_ENTITY_COUNT_BITS;

/**
 * The most players whose every snapshot fits SNAP_BUDGET_BITS without a scheduler (D-034): the
 * worst delta of the M3 design §2.1 size bounds is 312 + 233 bits per other player, so 36 others
 * fit (8700 bits) and 37 do not. Until the D-046 byte-budget scheduler a match admits at most this
 * many (`sv_maxClients` is clamped to it). The full form is smaller (checked below).
 */
export const SNAP_FIT_MAX_PLAYERS = 37;

if (SNAP_FULL_FIXED_BITS + (SNAP_FIT_MAX_PLAYERS - 1) * ENTITY_NEW_BITS > SNAP_BUDGET_BITS) {
  throw new Error("snapshot layout: a full snapshot of SNAP_FIT_MAX_PLAYERS does not fit");
}

/** The fields before the local block, and `teleportSeq` (decode only: the own slot's, D-035). */
export class SnapshotHeader {
  serverTick = 0;
  /** serverTick − baseline tick; 0 = full (the only form until D-038). */
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
}

const ORIGIN_BITS = 21;
const ORIGIN_Q_MAX = ORIGIN_LIMIT * ORIGIN_SCALE;
const ENTITY_VELOCITY_BITS = 16;
const EVENT_KIND_BITS = 4;
const SPECTATOR_MAX_BITS = MAX_SPECTATOR_SNAPSHOT_BYTES * 8;

/** The local block goes through the PlayerState codec (docs/05 §3.6), via this scratch. */
const scratch = new PlayerState();

/** Whether an entity's two event slots are canonical (kinds 0–3, empty slots last and zero). */
function eventsValid(k0: number, v0: number, k1: number, v1: number): boolean {
  if (k0 > PMEV_LAND || k1 > PMEV_LAND) return false;
  if (k0 === PMEV_NONE && (v0 !== 0 || k1 !== PMEV_NONE)) return false;
  if (k1 === PMEV_NONE && v1 !== 0) return false;
  return (k0 !== PMEV_JUMP || v0 === 0) && (k1 !== PMEV_JUMP || v1 === 0);
}

function writeOrigin(w: BitWriter, q: number): void {
  if (q > ORIGIN_Q_MAX || q < -ORIGIN_Q_MAX) w.fail();
  w.writeSigned(q, ORIGIN_BITS);
}

function writeEntityVelocity(w: BitWriter, q: number): void {
  if (q < -ENTITY_VELOCITY_MAX) w.fail();
  w.writeSigned(q, ENTITY_VELOCITY_BITS);
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
  const pitch = f.pitch[s] as number;
  if (pitch > PITCH_LIMIT_U16 || pitch < -PITCH_LIMIT_U16) w.fail();
  w.writeBits(pitch & 0xffff, 16);
  w.writeBits((f.flags[s] as number) & ENTITY_FLAG_MASK, 10);
  const team = f.team[s] as number;
  if (team > TEAM_2) w.fail();
  w.writeBits(team, 2);
  w.writeBits(f.teleportSeq[s] as number, 8);
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

/**
 * Encodes the snapshot of tick `hdr.serverTick` for receiver `selfId` from frame `cur`: its own
 * slot as the local block, every other present slot as a record. With SNAP_FLAG_SPECTATOR there is
 * no receiver and every present slot is a record. `base` must be null and `hdr.baseBack` 0: deltas
 * join with D-038. Returns false (the writer's error flag) on anything the layout can't carry: a
 * receiver absent from `cur`, a slot whose stamp is not the tick (pending or deferred, D-046), a
 * value out of range, or a live snapshot over MAX_SNAPSHOT_BYTES.
 */
export function encodeSnapshot(
  w: BitWriter,
  hdr: SnapshotHeader,
  cur: WorldFrame,
  base: WorldFrame | null,
  selfId: number,
): boolean {
  const flags = hdr.flags;
  const spectator = (flags & SNAP_FLAG_SPECTATOR) !== 0;
  const t = hdr.serverTick;
  if (base !== null || hdr.baseBack !== 0 || t < 1) w.fail();
  if ((flags & ~SNAP_FLAG_MASK) !== 0 || (spectator && (flags & SNAP_FLAG_STARVED) !== 0)) {
    w.fail();
  }
  w.writeBits(MSG_SNAPSHOT, 8);
  writeTick(w, t);
  w.writeBits(hdr.baseBack, 6);
  w.writeBits(flags, 8);
  w.writeBits(hdr.cvarHash, 16);
  let others = 0;
  if (!spectator) {
    if (!(selfId >= 0 && selfId < FRAME_SLOTS) || cur.present[selfId] !== 1) {
      w.fail();
      return false;
    }
    if (cur.stamp[selfId] !== t) w.fail();
    w.writeSigned(hdr.inputBufferHealth, 8);
    w.writeBits(cur.teleportSeq[selfId] as number, 8);
    slotToPlayerState(cur, selfId, scratch);
    encodePlayerState(w, scratch);
  }
  for (let s = 0; s < FRAME_SLOTS; s++) {
    if (cur.present[s] === 1 && (spectator || s !== selfId)) others++;
  }
  w.writeBits(others, SNAP_ENTITY_COUNT_BITS);
  for (let s = 0; s < FRAME_SLOTS; s++) {
    if (cur.present[s] !== 1 || (!spectator && s === selfId)) continue;
    if (cur.stamp[s] !== t) w.fail();
    writeNewRecord(w, cur, s);
  }
  if (w.bitLength > (spectator ? SPECTATOR_MAX_BITS : SNAP_BUDGET_BITS)) w.fail();
  return !w.error;
}

/**
 * Reads the fields before the local block (and health and teleportSeq) into `out`. False on a
 * short read, a tick of 0 or past TICK_MAX, a delta (baseBack ≠ 0, until D-038), or flags the
 * protocol refuses. `out` is then partial.
 */
export function decodeSnapshotHeader(r: BitReader, out: SnapshotHeader): boolean {
  if (r.readBits(8) !== MSG_SNAPSHOT) return false;
  const t = readTick(r);
  const baseBack = r.readBits(6);
  const flags = r.readBits(8);
  const cvarHash = r.readBits(16);
  const spectator = (flags & SNAP_FLAG_SPECTATOR) !== 0;
  if (t < 1 || baseBack !== 0 || (flags & ~SNAP_FLAG_MASK) !== 0) return false;
  if (spectator && (flags & SNAP_FLAG_STARVED) !== 0) return false;
  out.serverTick = t;
  out.baseBack = baseBack;
  out.flags = flags;
  out.cvarHash = cvarHash;
  if (spectator) {
    out.inputBufferHealth = 0;
    out.teleportSeq = 0;
  } else {
    out.inputBufferHealth = r.readSigned(8);
    out.teleportSeq = r.readBits(8);
  }
  return !r.error;
}

function originInRange(q: number): boolean {
  return q <= ORIGIN_Q_MAX && q >= -ORIGIN_Q_MAX;
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
    pitch > PITCH_LIMIT_U16 ||
    pitch < -PITCH_LIMIT_U16 ||
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
 * Reads the rest of a snapshot whose header `hdr` was just read into `out`, as receiver `selfId`
 * holds it: the own slot from the local block (present, stamp = the tick, teleportSeq from the
 * header; team and events not carried), each record's slot present with stamp = the tick, every
 * other slot absent. `base` must be null (deltas join with D-038). With SNAP_FLAG_SPECTATOR,
 * `selfId` is ignored. False on anything the encoder never writes (ids not strictly ascending or
 * ≥ 64, the receiver's own id, a removal or a non-"new" record in a full snapshot, out-of-range
 * fields, too many records, a live snapshot over MAX_SNAPSHOT_BYTES, bits after the last byte);
 * `out` is then partial and must be dropped.
 */
export function decodeSnapshotBody(
  r: BitReader,
  hdr: SnapshotHeader,
  base: WorldFrame | null,
  selfId: number,
  out: WorldFrame,
): boolean {
  if (base !== null || hdr.baseBack !== 0) return false;
  const spectator = (hdr.flags & SNAP_FLAG_SPECTATOR) !== 0;
  const t = hdr.serverTick;
  out.clear();
  if (!spectator) {
    if (!(selfId >= 0 && selfId < FRAME_SLOTS) || !decodePlayerState(r, scratch)) return false;
    out.setPresent(selfId, t);
    playerStateToSlot(out, selfId, scratch);
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
  let prev = -1;
  for (let i = 0; i < count; i++) {
    const id = r.readBits(16);
    if (id <= prev || id >= FRAME_SLOTS || (!spectator && id === selfId)) return false;
    prev = id;
    // A full snapshot has no baseline to remove from, and every record is a full body.
    if (r.readBits(1) !== 0 || r.readBits(1) !== 1) return false;
    if (!readNewBody(r, out, id, t)) return false;
  }
  if (r.bitPosition > (spectator ? SPECTATOR_MAX_BITS : SNAP_BUDGET_BITS)) return false;
  return r.atEnd();
}
