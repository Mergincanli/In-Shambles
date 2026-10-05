import { DEV_ASSERT } from "../debug/assert";
import { quantizeOriginVec3, quantizeStaminaHundredths, quantizeVelocityVec3 } from "../math/quant";
import { type Vec3, vec3 } from "../math/vec3";
import { TICK_MAX } from "../time";
import { ENTITY_NONE, ENTITY_WORLD } from "./entity";

/** Movement flags (docs/03 §6), bits 0..9 of PlayerState.flags. New flags take the next bit. */
export const PMF_GROUNDED = 1 << 0;
export const PMF_CROUCHED = 1 << 1;
export const PMF_SLIDING = 1 << 2;
export const PMF_CLIMBING = 1 << 3;
export const PMF_ON_LADDER = 1 << 4;
export const PMF_JUMP_HELD = 1 << 5;
export const PMF_CROUCH_PRESSED_IN_AIR = 1 << 6;
export const PMF_LEGS_BROKEN = 1 << 7;
export const PMF_LEG_WOUND = 1 << 8;
export const PMF_IN_WATER = 1 << 9;
export const PMF_MASK = 0x3ff;

export const WATER_LEVEL_MAX = 3;

/**
 * Everything movement simulates (docs/03 §6), predicted and replicated. Every scalar holds an
 * integer so V8 keeps it a small integer, and all fields are initialised here in a fixed order so
 * every instance shares one shape. New fields go at the end, and into copy, equals, diff and
 * quantize below.
 */
export class PlayerState {
  /** u, on the 1/32 grid. */
  readonly origin: Vec3 = vec3();
  /** u/s, on the 1/16 grid. */
  readonly velocity: Vec3 = vec3();
  /** u16 angle units. */
  viewYaw = 0;
  viewPitch = 0;
  /** PMF_* bits. */
  flags = 0;
  /** i16 entity number, ENTITY_NONE when airborne. */
  groundEntity = ENTITY_NONE;
  /** 0 (dry) to 3 (submerged), docs/03 §4.13. */
  waterLevel = 0;
  /** u16 integer hundredths (docs/03 §6 "fixed-point ×100"), so 100 is one stamina point. */
  stamina = 0;
}

export function copyPlayerState(dst: PlayerState, src: PlayerState): PlayerState {
  dst.origin.set(src.origin);
  dst.velocity.set(src.velocity);
  dst.viewYaw = src.viewYaw;
  dst.viewPitch = src.viewPitch;
  dst.flags = src.flags;
  dst.groundEntity = src.groundEntity;
  dst.waterLevel = src.waterLevel;
  dst.stamina = src.stamina;
  return dst;
}

/**
 * Exact `===` on every field: the prediction check. Quantized states never hold −0 or NaN, so
 * this is bit equality for them.
 */
export function playerStateEquals(a: PlayerState, b: PlayerState): boolean {
  const ao = a.origin;
  const bo = b.origin;
  const av = a.velocity;
  const bv = b.velocity;
  return (
    ao[0] === bo[0] &&
    ao[1] === bo[1] &&
    ao[2] === bo[2] &&
    av[0] === bv[0] &&
    av[1] === bv[1] &&
    av[2] === bv[2] &&
    a.viewYaw === b.viewYaw &&
    a.viewPitch === b.viewPitch &&
    a.flags === b.flags &&
    a.groundEntity === b.groundEntity &&
    a.waterLevel === b.waterLevel &&
    a.stamina === b.stamina
  );
}

/**
 * The fields where `a` and `b` differ, as "field: a → b", using the same `===` as
 * playerStateEquals (empty exactly when it returns true). Debug and test helper: allocates.
 */
export function diffPlayerState(a: PlayerState, b: PlayerState): string[] {
  const out: string[] = [];
  const add = (field: string, x: number, y: number) => {
    if (x !== y) out.push(`${field}: ${x} → ${y}`);
  };
  for (let i = 0; i < 3; i++) add(`origin[${i}]`, a.origin[i] ?? 0, b.origin[i] ?? 0);
  for (let i = 0; i < 3; i++) add(`velocity[${i}]`, a.velocity[i] ?? 0, b.velocity[i] ?? 0);
  add("viewYaw", a.viewYaw, b.viewYaw);
  add("viewPitch", a.viewPitch, b.viewPitch);
  add("flags", a.flags, b.flags);
  add("groundEntity", a.groundEntity, b.groundEntity);
  add("waterLevel", a.waterLevel, b.waterLevel);
  add("stamina", a.stamina, b.stamina);
  return out;
}

/** Truncates into [ENTITY_NONE, ENTITY_WORLD]. NaN becomes ENTITY_NONE, not 0: 0 is a real entity. */
function quantizeGroundEntity(g: number): number {
  DEV_ASSERT(Number.isFinite(g), "groundEntity must be finite", g);
  if (Number.isNaN(g) || g <= ENTITY_NONE) return ENTITY_NONE;
  if (g >= ENTITY_WORLD) return ENTITY_WORLD;
  return g | 0;
}

function quantizeWaterLevel(w: number): number {
  DEV_ASSERT(Number.isFinite(w), "waterLevel must be finite", w);
  if (!(w > 0)) return 0;
  if (w >= WATER_LEVEL_MAX) return WATER_LEVEL_MAX;
  return w | 0;
}

/**
 * End-of-tick quantization of the whole state, in place (docs/05 §4.1), on client and server
 * alike so a correct prediction matches the server bit for bit. Idempotent, never yields −0, and
 * every field ends in the range its codec carries:
 * - origin and velocity: math/quant grids and clamps;
 * - angles `& 0xFFFF` and flags `& PMF_MASK` (wrap, truncating toward zero);
 * - groundEntity to [ENTITY_NONE, ENTITY_WORLD] and waterLevel to 0..3, truncating;
 * - stamina to the nearest hundredth in 0..65535 (a continuous quantity, so it rounds).
 *
 * Non-finite values are bugs: DEV_ASSERT in dev; in prod NaN becomes 0 (groundEntity:
 * ENTITY_NONE), clamped fields take their bound for ±Infinity and masked fields take 0.
 */
export function quantizePlayerState(ps: PlayerState): PlayerState {
  quantizeOriginVec3(ps.origin);
  quantizeVelocityVec3(ps.velocity);
  DEV_ASSERT(Number.isFinite(ps.viewYaw), "viewYaw must be finite", ps.viewYaw);
  ps.viewYaw &= 0xffff;
  DEV_ASSERT(Number.isFinite(ps.viewPitch), "viewPitch must be finite", ps.viewPitch);
  ps.viewPitch &= 0xffff;
  DEV_ASSERT(Number.isFinite(ps.flags), "flags must be finite", ps.flags);
  ps.flags &= PMF_MASK;
  ps.groundEntity = quantizeGroundEntity(ps.groundEntity);
  ps.waterLevel = quantizeWaterLevel(ps.waterLevel);
  ps.stamina = quantizeStaminaHundredths(ps.stamina);
  return ps;
}

/** Ring size: a power of two, so the slot is `tick & (capacity − 1)`. 128 ticks is about 2.1 s. */
export const PLAYER_STATE_RING_CAPACITY = 128;
const RING_MASK = PLAYER_STATE_RING_CAPACITY - 1;

function isRingTick(tick: number): boolean {
  return Number.isInteger(tick) && tick >= 0 && tick <= TICK_MAX;
}

/**
 * The last 128 ticks of one player's state (prediction history, reconciliation). Slots are
 * preallocated and remember which tick they hold, so a read of an overwritten or never-written
 * tick reports a miss instead of returning another tick's state.
 */
export class PlayerStateRing {
  private readonly slots: PlayerState[] = [];
  private readonly ticks = new Int32Array(PLAYER_STATE_RING_CAPACITY).fill(-1);

  constructor() {
    for (let i = 0; i < PLAYER_STATE_RING_CAPACITY; i++) this.slots.push(new PlayerState());
  }

  /** Copies `src` in as `tick`'s state, replacing whatever tick shared its slot. */
  write(tick: number, src: PlayerState): void {
    DEV_ASSERT(isRingTick(tick), "ring tick must be an integer in 0..TICK_MAX", tick);
    if (!isRingTick(tick)) return;
    const i = tick & RING_MASK;
    const slot = this.slots[i];
    if (slot === undefined) return;
    copyPlayerState(slot, src);
    this.ticks[i] = tick;
  }

  /** Copies `tick`'s state into `out` and returns true; false (out untouched) if it isn't held. */
  read(tick: number, out: PlayerState): boolean {
    if (!isRingTick(tick)) return false;
    const i = tick & RING_MASK;
    const slot = this.slots[i];
    if (slot === undefined || this.ticks[i] !== tick) return false;
    copyPlayerState(out, slot);
    return true;
  }

  has(tick: number): boolean {
    return isRingTick(tick) && this.ticks[tick & RING_MASK] === tick;
  }

  /** Forgets every tick (reconnect, respawn). */
  clear(): void {
    this.ticks.fill(-1);
  }
}
