import { ORIGIN_SCALE, toSigned16, VELOCITY_SCALE } from "../math/quant";
import { hash32 } from "../rng/hash32";
import { ENTITY_FLAG_MASK, MATCH_MAX_CLIENTS } from "../sim/entity";
import { PMEV_BOOT, PMEV_LAND, PMEV_STEP, type PmoveEvent } from "../sim/events";
import type { PlayerState } from "../sim/playerState";
import { SNAPSHOT_HISTORY } from "./protocol";

/**
 * One tick of every player slot as typed arrays (M3 design §2.2, D-034): what the server simulated
 * and what a client holds of it after a snapshot, in the integer units the wire carries, so frames
 * compare and hash exactly. Slot = client id = entity id.
 *
 * - The server fills every field of every active slot, with `stamp` = the frame's tick.
 * - A client fills its own slot from the snapshot's local block (plus `teleportSeq` from the
 *   header) and, for every other slot, only the entity fields, `present` and `stamp`.
 * - `stamp` is the server tick a slot's state belongs to; 0 marks a pending slot (present, no state
 *   yet; D-046). A slot the byte-budget scheduler left out keeps its baseline's state and stamp,
 *   an older tick; every other present slot's stamp is the frame's tick.
 *
 * `masks` keeps the present and pending sets as two 64-bit masks (lo/hi Int32 halves) in step with
 * `present` and `stamp`, so counts are popcounts. Every write that changes a slot's presence goes
 * through `setPresent`/`setAbsent`/`clear`/`copySlot`. No method allocates.
 */
export const FRAME_SLOTS = MATCH_MAX_CLIENTS;
/** Movement events a remote player's entity keeps (docs/05 §10: eventSeq + the last 2). */
export const ENTITY_EVENT_SLOTS = 2;

/** `WorldFrame.masks` lanes. */
export const MASK_PRESENT_LO = 0;
export const MASK_PRESENT_HI = 1;
export const MASK_PENDING_LO = 2;
export const MASK_PENDING_HI = 3;

/**
 * Lanes of `WorldFrame.locals`: the local-block-only fields of protocol v4 (M4 design §2.2), at
 * `slot * LF_COUNT + LF_*`, in PlayerState order. One strided Int16Array instead of eleven arrays
 * keeps a frame's object count and the per-frame cost down (every value fits i16: health ≤ 16383,
 * climbHeight i12, the rest ≤ 2047).
 */
export const LF_WALL_JUMPS = 0;
export const LF_HEALTH = 1;
export const LF_ARMOR = 2;
export const LF_SUBMERGED = 3;
export const LF_CLIMB_HEIGHT = 4;
export const LF_CLIMB_YAW = 5;
export const LF_REGEN_DELAY = 6;
export const LF_KICK_COOLDOWN = 7;
export const LF_REGRAB = 8;
export const LF_WATER_JUMP = 9;
export const LF_BANDAGE = 10;
export const LF_COUNT = 11;

/** Entity velocity is 1 u/s, i16 (design, INFERRED adequate for ≤ 2-tick extrapolation). */
export const ENTITY_VELOCITY_MAX = 32767;

function bitCount(v: number): number {
  let x = v - ((v >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
}

export class WorldFrame {
  readonly present = new Uint8Array(FRAME_SLOTS);
  /** The server tick of the slot's state; 0 = pending. */
  readonly stamp = new Int32Array(FRAME_SLOTS);
  /**
   * On the server, the slot's connect counter, which tells the encoder a slot holds a new player.
   * On the client, a stand-in the decoder keeps (the baseline's, + 1 for a "new" record over a
   * slot it holds) only so a re-encode against the same baseline picks the same body forms (D-038).
   */
  readonly serial = new Uint16Array(FRAME_SLOTS);
  /** 1/32 u. */
  readonly originX = new Int32Array(FRAME_SLOTS);
  readonly originY = new Int32Array(FRAME_SLOTS);
  readonly originZ = new Int32Array(FRAME_SLOTS);
  /** 1/16 u/s (the local block's velocity). */
  readonly vel16X = new Int32Array(FRAME_SLOTS);
  readonly vel16Y = new Int32Array(FRAME_SLOTS);
  readonly vel16Z = new Int32Array(FRAME_SLOTS);
  /** 1 u/s (the entity's velocity): `entityVelocity(vel16)`. */
  readonly entVelX = new Int16Array(FRAME_SLOTS);
  readonly entVelY = new Int16Array(FRAME_SLOTS);
  readonly entVelZ = new Int16Array(FRAME_SLOTS);
  /** u16 angle units. */
  readonly yaw = new Uint16Array(FRAME_SLOTS);
  /** Signed angle units, within ±PITCH_LIMIT_U16. */
  readonly pitch = new Int16Array(FRAME_SLOTS);
  /** PMF_* bits; a client's remote slots hold `flags & ENTITY_FLAG_MASK`. */
  readonly flags = new Uint16Array(FRAME_SLOTS);
  /** groundEntity + 1 (0 = ENTITY_NONE). */
  readonly ground1 = new Uint16Array(FRAME_SLOTS);
  readonly waterLevel = new Uint8Array(FRAME_SLOTS);
  /** Hundredths. */
  readonly stamina = new Uint16Array(FRAME_SLOTS);
  /** The v4 local-only fields: LF_* lanes, slot s at `s * LF_COUNT` (0 for a client's remotes). */
  readonly locals = new Int16Array(FRAME_SLOTS * LF_COUNT);
  /** TEAM_*. */
  readonly team = new Uint8Array(FRAME_SLOTS);
  /** Bumped by every spawn (D-035): the only snap signal. */
  readonly teleportSeq = new Uint8Array(FRAME_SLOTS);
  /** Movement events: a counter and the two newest (kind, value), at `slot * 2 + i`. */
  readonly eventSeq = new Uint8Array(FRAME_SLOTS);
  readonly evKind = new Uint8Array(FRAME_SLOTS * ENTITY_EVENT_SLOTS);
  readonly evValue = new Uint8Array(FRAME_SLOTS * ENTITY_EVENT_SLOTS);
  /** Present and pending sets: MASK_* lanes, slot s at bit s & 31 of lane s >> 5. */
  readonly masks = new Int32Array(4);

  /** Every slot absent. */
  clear(): void {
    this.present.fill(0);
    this.stamp.fill(0);
    this.masks.fill(0);
  }

  /** Marks `slot` present with state of tick `stamp` (0: pending). */
  setPresent(slot: number, stamp: number): void {
    const bit = 1 << (slot & 31);
    const hi = slot >> 5;
    const m = this.masks;
    this.present[slot] = 1;
    this.stamp[slot] = stamp;
    m[MASK_PRESENT_LO + hi] = (m[MASK_PRESENT_LO + hi] as number) | bit;
    if (stamp === 0) m[MASK_PENDING_LO + hi] = (m[MASK_PENDING_LO + hi] as number) | bit;
    else m[MASK_PENDING_LO + hi] = (m[MASK_PENDING_LO + hi] as number) & ~bit;
  }

  setAbsent(slot: number): void {
    const bit = ~(1 << (slot & 31));
    const hi = slot >> 5;
    const m = this.masks;
    this.present[slot] = 0;
    this.stamp[slot] = 0;
    m[MASK_PRESENT_LO + hi] = (m[MASK_PRESENT_LO + hi] as number) & bit;
    m[MASK_PENDING_LO + hi] = (m[MASK_PENDING_LO + hi] as number) & bit;
  }

  get presentCount(): number {
    const m = this.masks;
    return bitCount(m[MASK_PRESENT_LO] as number) + bitCount(m[MASK_PRESENT_HI] as number);
  }

  get pendingCount(): number {
    const m = this.masks;
    return bitCount(m[MASK_PENDING_LO] as number) + bitCount(m[MASK_PENDING_HI] as number);
  }

  /** Slots present here (pending included) and absent in `other`: popcounts of the masks. */
  presentNotIn(other: WorldFrame): number {
    const m = this.masks;
    const o = other.masks;
    return (
      bitCount((m[MASK_PRESENT_LO] as number) & ~(o[MASK_PRESENT_LO] as number)) +
      bitCount((m[MASK_PRESENT_HI] as number) & ~(o[MASK_PRESENT_HI] as number))
    );
  }
}

/** 1/16 u/s → the entity's 1 u/s, rounded half up and clamped to ±ENTITY_VELOCITY_MAX. */
export function entityVelocity(vel16: number): number {
  return Math.max(-ENTITY_VELOCITY_MAX, Math.min(ENTITY_VELOCITY_MAX, (vel16 + 8) >> 4));
}

/** The largest LAND value (the 8-bit cap): an impact of 4072 u/s or more, rounded / 16. */
export const ENTITY_LAND_VALUE_MAX = 255;

/**
 * A movement event's value as an entity record carries it (8 bits, M3 design §2.1): STEP the height
 * change rounded to whole u as i8 (two's complement), JUMP 0, LAND the impact speed / 16 rounded,
 * at most 255, BOOT the victim's client id (< 64); anything else 0 (WALLKICK, GRAB, WATER_JUMP, and
 * the local-only kinds, which the match never files). Takes the event, not its value, so no double
 * crosses the call (`| 0` keeps −0 and every result a small integer).
 */
export function entityEventValue(ev: Readonly<PmoveEvent>): number {
  const kind = ev.type;
  if (kind === PMEV_STEP) {
    return Math.max(-128, Math.min(127, Math.round(ev.value) | 0)) & 0xff;
  }
  if (kind === PMEV_LAND) {
    return Math.max(0, Math.min(ENTITY_LAND_VALUE_MAX, Math.round(ev.value / 16) | 0));
  }
  if (kind === PMEV_BOOT) return Math.max(0, Math.min(MATCH_MAX_CLIENTS - 1, ev.value | 0));
  return 0;
}

/**
 * Appends an event (kind, 8-bit value) to `slot`'s history: the two newest, newest first at
 * `slot * 2`, and a wrapping 8-bit count, as entities carry them (docs/05 §10). Works on a
 * `WorldFrame`'s `eventSeq`/`evKind`/`evValue` and on any arrays of that shape.
 */
export function pushEntityEvent(
  eventSeq: Uint8Array,
  evKind: Uint8Array,
  evValue: Uint8Array,
  slot: number,
  kind: number,
  value: number,
): void {
  const e = slot * ENTITY_EVENT_SLOTS;
  evKind[e + 1] = evKind[e] as number;
  evValue[e + 1] = evValue[e] as number;
  evKind[e] = kind;
  evValue[e] = value;
  eventSeq[slot] = ((eventSeq[slot] as number) + 1) & 0xff;
}

/**
 * Writes a quantized `ps` into `slot`'s state fields (origin, both velocities, angles, flags,
 * ground, water, stamina, the v4 local lanes): exact, since end-of-tick quantization leaves every
 * field on the wire grid. Presence, stamp, serial, team, teleportSeq and events are the caller's.
 */
export function playerStateToSlot(f: WorldFrame, slot: number, ps: Readonly<PlayerState>): void {
  const o = ps.origin;
  const v = ps.velocity;
  f.originX[slot] = o[0] * ORIGIN_SCALE;
  f.originY[slot] = o[1] * ORIGIN_SCALE;
  f.originZ[slot] = o[2] * ORIGIN_SCALE;
  const vx = v[0] * VELOCITY_SCALE;
  const vy = v[1] * VELOCITY_SCALE;
  const vz = v[2] * VELOCITY_SCALE;
  f.vel16X[slot] = vx;
  f.vel16Y[slot] = vy;
  f.vel16Z[slot] = vz;
  f.entVelX[slot] = entityVelocity(vx);
  f.entVelY[slot] = entityVelocity(vy);
  f.entVelZ[slot] = entityVelocity(vz);
  f.yaw[slot] = ps.viewYaw;
  f.pitch[slot] = toSigned16(ps.viewPitch);
  f.flags[slot] = ps.flags;
  f.ground1[slot] = ps.groundEntity + 1;
  f.waterLevel[slot] = ps.waterLevel;
  f.stamina[slot] = ps.stamina;
  const l = f.locals;
  const b = slot * LF_COUNT;
  l[b + LF_WALL_JUMPS] = ps.wallJumps;
  l[b + LF_HEALTH] = ps.health;
  l[b + LF_ARMOR] = ps.armor;
  l[b + LF_SUBMERGED] = ps.submerged;
  l[b + LF_CLIMB_HEIGHT] = ps.climbHeight;
  l[b + LF_CLIMB_YAW] = ps.climbYaw;
  l[b + LF_REGEN_DELAY] = ps.regenDelay;
  l[b + LF_KICK_COOLDOWN] = ps.kickCooldown;
  l[b + LF_REGRAB] = ps.regrab;
  l[b + LF_WATER_JUMP] = ps.waterJump;
  l[b + LF_BANDAGE] = ps.bandage;
}

/** The inverse of `playerStateToSlot`, bit for bit: what prediction reads (D-034, M3 design §2.3). */
export function slotToPlayerState(f: WorldFrame, slot: number, out: PlayerState): void {
  const o = out.origin;
  const v = out.velocity;
  o[0] = (f.originX[slot] as number) / ORIGIN_SCALE;
  o[1] = (f.originY[slot] as number) / ORIGIN_SCALE;
  o[2] = (f.originZ[slot] as number) / ORIGIN_SCALE;
  v[0] = (f.vel16X[slot] as number) / VELOCITY_SCALE;
  v[1] = (f.vel16Y[slot] as number) / VELOCITY_SCALE;
  v[2] = (f.vel16Z[slot] as number) / VELOCITY_SCALE;
  out.viewYaw = f.yaw[slot] as number;
  out.viewPitch = (f.pitch[slot] as number) & 0xffff;
  out.flags = f.flags[slot] as number;
  out.groundEntity = (f.ground1[slot] as number) - 1;
  out.waterLevel = f.waterLevel[slot] as number;
  out.stamina = f.stamina[slot] as number;
  const l = f.locals;
  const b = slot * LF_COUNT;
  out.wallJumps = l[b + LF_WALL_JUMPS] as number;
  out.health = l[b + LF_HEALTH] as number;
  out.armor = l[b + LF_ARMOR] as number;
  out.submerged = l[b + LF_SUBMERGED] as number;
  out.climbHeight = l[b + LF_CLIMB_HEIGHT] as number;
  out.climbYaw = l[b + LF_CLIMB_YAW] as number;
  out.regenDelay = l[b + LF_REGEN_DELAY] as number;
  out.kickCooldown = l[b + LF_KICK_COOLDOWN] as number;
  out.regrab = l[b + LF_REGRAB] as number;
  out.waterJump = l[b + LF_WATER_JUMP] as number;
  out.bandage = l[b + LF_BANDAGE] as number;
}

/** Zeroes slot `s`'s v4 local lanes (a remote's: they are not on the wire). */
export function clearLocals(f: WorldFrame, s: number): void {
  const l = f.locals;
  const b = s * LF_COUNT;
  for (let i = 0; i < LF_COUNT; i++) l[b + i] = 0;
}

/** Copies slot `ss` of `src` into slot `ds` of `dst`, presence and stamp included. */
export function copySlot(dst: WorldFrame, ds: number, src: WorldFrame, ss: number): void {
  if (src.present[ss] === 1) dst.setPresent(ds, src.stamp[ss] as number);
  else dst.setAbsent(ds);
  dst.serial[ds] = src.serial[ss] as number;
  dst.originX[ds] = src.originX[ss] as number;
  dst.originY[ds] = src.originY[ss] as number;
  dst.originZ[ds] = src.originZ[ss] as number;
  dst.vel16X[ds] = src.vel16X[ss] as number;
  dst.vel16Y[ds] = src.vel16Y[ss] as number;
  dst.vel16Z[ds] = src.vel16Z[ss] as number;
  dst.entVelX[ds] = src.entVelX[ss] as number;
  dst.entVelY[ds] = src.entVelY[ss] as number;
  dst.entVelZ[ds] = src.entVelZ[ss] as number;
  dst.yaw[ds] = src.yaw[ss] as number;
  dst.pitch[ds] = src.pitch[ss] as number;
  dst.flags[ds] = src.flags[ss] as number;
  dst.ground1[ds] = src.ground1[ss] as number;
  dst.waterLevel[ds] = src.waterLevel[ss] as number;
  dst.stamina[ds] = src.stamina[ss] as number;
  const dl = dst.locals;
  const sl = src.locals;
  const db = ds * LF_COUNT;
  const sb = ss * LF_COUNT;
  for (let i = 0; i < LF_COUNT; i++) dl[db + i] = sl[sb + i] as number;
  dst.team[ds] = src.team[ss] as number;
  dst.teleportSeq[ds] = src.teleportSeq[ss] as number;
  dst.eventSeq[ds] = src.eventSeq[ss] as number;
  const d2 = ds * ENTITY_EVENT_SLOTS;
  const s2 = ss * ENTITY_EVENT_SLOTS;
  for (let i = 0; i < ENTITY_EVENT_SLOTS; i++) {
    dst.evKind[d2 + i] = src.evKind[s2 + i] as number;
    dst.evValue[d2 + i] = src.evValue[s2 + i] as number;
  }
}

/**
 * Whether two slots hold the same entity state (what a remote's entity record carries): origin,
 * entity velocity, angles, masked flags, team, teleportSeq and events. Presence is the caller's.
 */
export function entityEquals(a: WorldFrame, sa: number, b: WorldFrame, sb: number): boolean {
  if (
    a.originX[sa] !== b.originX[sb] ||
    a.originY[sa] !== b.originY[sb] ||
    a.originZ[sa] !== b.originZ[sb] ||
    a.entVelX[sa] !== b.entVelX[sb] ||
    a.entVelY[sa] !== b.entVelY[sb] ||
    a.entVelZ[sa] !== b.entVelZ[sb] ||
    a.yaw[sa] !== b.yaw[sb] ||
    a.pitch[sa] !== b.pitch[sb] ||
    ((a.flags[sa] as number) & ENTITY_FLAG_MASK) !== ((b.flags[sb] as number) & ENTITY_FLAG_MASK) ||
    a.team[sa] !== b.team[sb] ||
    a.teleportSeq[sa] !== b.teleportSeq[sb] ||
    a.eventSeq[sa] !== b.eventSeq[sb]
  ) {
    return false;
  }
  const a2 = sa * ENTITY_EVENT_SLOTS;
  const b2 = sb * ENTITY_EVENT_SLOTS;
  for (let i = 0; i < ENTITY_EVENT_SLOTS; i++) {
    if (a.evKind[a2 + i] !== b.evKind[b2 + i] || a.evValue[a2 + i] !== b.evValue[b2 + i]) {
      return false;
    }
  }
  return true;
}

const DIGEST_SEED = 0x77667264;

/**
 * A hash of what receiver `selfId` (−1: a spectator) holds of a frame (M3 design §2.2), so a
 * client's stored frame can be checked against the frame the server encoded it from: its own slot
 * by exactly the local-block fields plus teleportSeq and stamp (not team, which arrives on EVENTS),
 * every other slot by presence, pending, stamp and exactly the entity fields (not `serial`). Test
 * and harness use; allocation-free all the same.
 */
export function frameDigest(f: WorldFrame, selfId: number): number {
  let h = DIGEST_SEED;
  for (let s = 0; s < FRAME_SLOTS; s++) {
    const present = f.present[s] as number;
    h = hash32(h, s, present, present === 1 ? (f.stamp[s] as number) : 0, s === selfId ? 1 : 0);
    if (present === 0) continue;
    if (s === selfId) {
      h = hash32(
        h,
        f.originX[s] as number,
        f.originY[s] as number,
        f.originZ[s] as number,
        f.teleportSeq[s] as number,
      );
      h = hash32(h, f.vel16X[s] as number, f.vel16Y[s] as number, f.vel16Z[s] as number, 0);
      h = hash32(
        h,
        f.yaw[s] as number,
        (f.pitch[s] as number) & 0xffff,
        f.flags[s] as number,
        f.ground1[s] as number,
      );
      h = hash32(h, f.waterLevel[s] as number, f.stamina[s] as number, 0, 0);
      const l = f.locals;
      const b = s * LF_COUNT;
      // Four lanes a call, LF_COUNT (11) of them: 0–3, 4–7, 8–10.
      h = hash32(h, l[b] as number, l[b + 1] as number, l[b + 2] as number, l[b + 3] as number);
      h = hash32(h, l[b + 4] as number, l[b + 5] as number, l[b + 6] as number, l[b + 7] as number);
      h = hash32(h, l[b + 8] as number, l[b + 9] as number, l[b + 10] as number, 0);
      continue;
    }
    if (f.stamp[s] === 0) continue;
    const e = s * ENTITY_EVENT_SLOTS;
    h = hash32(
      h,
      f.originX[s] as number,
      f.originY[s] as number,
      f.originZ[s] as number,
      f.teleportSeq[s] as number,
    );
    h = hash32(
      h,
      f.entVelX[s] as number,
      f.entVelY[s] as number,
      f.entVelZ[s] as number,
      f.team[s] as number,
    );
    h = hash32(
      h,
      f.yaw[s] as number,
      (f.pitch[s] as number) & 0xffff,
      (f.flags[s] as number) & ENTITY_FLAG_MASK,
      f.eventSeq[s] as number,
    );
    h = hash32(
      h,
      f.evKind[e] as number,
      f.evValue[e] as number,
      f.evKind[e + 1] as number,
      f.evValue[e + 1] as number,
    );
  }
  return h;
}

const RING_MASK = SNAPSHOT_HISTORY - 1;

/**
 * The last SNAPSHOT_HISTORY frames by tick (index `tick & 63`), each slot remembering the tick it
 * holds, so a lookup of an overwritten or never-stored tick misses instead of returning another
 * tick's frame. No snapshot is ever of tick 0, so 0 marks an empty slot.
 */
export class FrameRing {
  private readonly frames: WorldFrame[] = [];
  private readonly ticks = new Int32Array(SNAPSHOT_HISTORY);

  constructor() {
    for (let i = 0; i < SNAPSHOT_HISTORY; i++) this.frames.push(new WorldFrame());
  }

  /** The tick held at ring index `index` (0–63), 0 when empty. */
  tickAt(index: number): number {
    return this.ticks[index & RING_MASK] as number;
  }

  /** Whether `tick`'s frame is held. */
  has(tick: number): boolean {
    return tick > 0 && this.ticks[tick & RING_MASK] === tick;
  }

  /** The frame held for `tick`, or null. */
  get(tick: number): WorldFrame | null {
    return this.has(tick) ? (this.frames[tick & RING_MASK] as WorldFrame) : null;
  }

  /** The frame object at `tick`'s index, to fill; it is `tick`'s once `store(tick)` marks it. */
  slot(tick: number): WorldFrame {
    return this.frames[tick & RING_MASK] as WorldFrame;
  }

  store(tick: number): void {
    this.ticks[tick & RING_MASK] = tick;
  }

  /** Forgets `tick` if it is held. */
  invalidate(tick: number): void {
    if (this.has(tick)) this.ticks[tick & RING_MASK] = 0;
  }

  /**
   * Holds `frame` as `tick`'s frame, in place of whatever its index held, and returns the frame
   * object it replaced, for the caller to reuse (a decode target swapped in without a copy).
   */
  swapIn(tick: number, frame: WorldFrame): WorldFrame {
    const i = tick & RING_MASK;
    const old = this.frames[i] as WorldFrame;
    this.frames[i] = frame;
    this.ticks[i] = tick;
    return old;
  }

  clear(): void {
    this.ticks.fill(0);
  }
}
