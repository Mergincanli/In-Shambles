import { DEV_ASSERT } from "../debug/assert";
import { quantizeOriginVec3, quantizeStaminaHundredths, quantizeVelocityVec3 } from "../math/quant";
import { type Vec3, vec3 } from "../math/vec3";
import { TICK_MAX } from "../time";
import { ENTITY_NONE, ENTITY_WORLD } from "./entity";

/** Movement flags (docs/03 §6), bits 0..10 of PlayerState.flags. New flags take the next bit. */
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
/**
 * Set on a ledge drop, cleared when neither forward nor jump is held (M4 design §2.8): the
 * re-grab's fresh-press gate. Owner only: outside ENTITY_FLAG_MASK, never in an entity record.
 */
export const PMF_GRAB_LOCK = 1 << 10;
export const PMF_MASK = 0x7ff;
/** The flags field's width on the wire (protocol v4, D-053). */
export const PMF_BITS = 11;

export const WATER_LEVEL_MAX = 3;

/**
 * Wire widths of the v4 fields (M4 design §2.2, D-053). Each field holds an integer that
 * quantizePlayerState clamps (or masks) into its width, so "decode accepts ⇒ quantize leaves it
 * unchanged" holds; the codec and the delta local block write exactly these widths.
 */
export const WALL_JUMPS_BITS = 3;
export const HEALTH_BITS = 14;
export const ARMOR_BITS = 2;
export const SUBMERGED_BITS = 11;
/** Signed. */
export const CLIMB_HEIGHT_BITS = 12;
export const CLIMB_YAW_BITS = 8;
export const REGEN_DELAY_BITS = 7;
export const KICK_COOLDOWN_BITS = 6;
export const REGRAB_BITS = 4;
export const WATER_JUMP_BITS = 6;
export const BANDAGE_BITS = 8;

const WALL_JUMPS_MAX = (1 << WALL_JUMPS_BITS) - 1;
/** Hundredths; the game's maximum is PLAYER_HEALTH_MAX, the width's 16383. */
export const HEALTH_Q_MAX = (1 << HEALTH_BITS) - 1;
const SUBMERGED_MAX = (1 << SUBMERGED_BITS) - 1;
export const CLIMB_HEIGHT_Q_MAX = (1 << (CLIMB_HEIGHT_BITS - 1)) - 1;
export const CLIMB_HEIGHT_Q_MIN = -(1 << (CLIMB_HEIGHT_BITS - 1));
const REGEN_DELAY_MAX = (1 << REGEN_DELAY_BITS) - 1;
const KICK_COOLDOWN_MAX = (1 << KICK_COOLDOWN_BITS) - 1;
const REGRAB_MAX = (1 << REGRAB_BITS) - 1;
const WATER_JUMP_MAX = (1 << WATER_JUMP_BITS) - 1;
const BANDAGE_MAX = (1 << BANDAGE_BITS) - 1;

/** Full health in hundredths: 100 HP (FACT, docs/04 §3). */
export const PLAYER_HEALTH_MAX = 100 * 100;
/** Stamina at spawn, in hundredths: staminaMax = health 100 with no vest (docs/03 §5.2, FACT). */
export const PLAYER_STAMINA_FULL = 100 * 100;
/** `armor` bits (M4 design §2.2): the vest (at spawn from `sv_spawnVest` until M6), the helmet. */
export const ARMOR_VEST = 1 << 0;
export const ARMOR_HELMET = 1 << 1;
export const ARMOR_MASK = ARMOR_VEST | ARMOR_HELMET;

/**
 * The movement state (docs/03 §6), predicted and replicated. Protocol v4 (M4 design §2.2, D-053)
 * lays out every field M4 simulates at once; each stays inert until the increment that gives it
 * its meaning. Every scalar holds an integer so V8 keeps it a small integer, and all fields are
 * initialised here in a fixed order so every instance shares one shape. New fields go at the end,
 * and into copy, equals, diff, quantize and resetPlayerStateForSpawn below (the behavioural field
 * guard, `playerStateFields.test.ts`, catches a field one of them misses).
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
  /** Wall jumps since the last walkable landing, 0–7. */
  wallJumps = 0;
  /** Hundredths, 0–16383 (the game's max PLAYER_HEALTH_MAX); 0 is dead. */
  health = 0;
  /** ARMOR_* bits. */
  armor = 0;
  /** Ticks with the eyes under water, saturating at 2047; 0 when they are out. */
  submerged = 0;
  /** 1/32 u, the ledge top − origin z, −2048…2047; 0 unless CLIMBING. */
  climbHeight = 0;
  /** The view yaw at the grab >> 8, 0–255; 0 unless CLIMBING. */
  climbYaw = 0;
  /** Ticks before stamina regenerates, 0–127. */
  regenDelay = 0;
  /** Ticks before the next boot, 0–63. */
  kickCooldown = 0;
  /** Ticks, 0–15: the re-grab countdown, or while CLIMBING the climb finish's ticks left. */
  regrab = 0;
  /** Ticks left of a water-jump, 0–63. */
  waterJump = 0;
  /** Ticks the self-bandage has been held, 0–255. */
  bandage = 0;
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
  dst.wallJumps = src.wallJumps;
  dst.health = src.health;
  dst.armor = src.armor;
  dst.submerged = src.submerged;
  dst.climbHeight = src.climbHeight;
  dst.climbYaw = src.climbYaw;
  dst.regenDelay = src.regenDelay;
  dst.kickCooldown = src.kickCooldown;
  dst.regrab = src.regrab;
  dst.waterJump = src.waterJump;
  dst.bandage = src.bandage;
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
    a.stamina === b.stamina &&
    a.wallJumps === b.wallJumps &&
    a.health === b.health &&
    a.armor === b.armor &&
    a.submerged === b.submerged &&
    a.climbHeight === b.climbHeight &&
    a.climbYaw === b.climbYaw &&
    a.regenDelay === b.regenDelay &&
    a.kickCooldown === b.kickCooldown &&
    a.regrab === b.regrab &&
    a.waterJump === b.waterJump &&
    a.bandage === b.bandage
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
  add("wallJumps", a.wallJumps, b.wallJumps);
  add("health", a.health, b.health);
  add("armor", a.armor, b.armor);
  add("submerged", a.submerged, b.submerged);
  add("climbHeight", a.climbHeight, b.climbHeight);
  add("climbYaw", a.climbYaw, b.climbYaw);
  add("regenDelay", a.regenDelay, b.regenDelay);
  add("kickCooldown", a.kickCooldown, b.kickCooldown);
  add("regrab", a.regrab, b.regrab);
  add("waterJump", a.waterJump, b.waterJump);
  add("bandage", a.bandage, b.bandage);
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
 * A counter or timer: truncated into 0..max. NaN is 0, +Infinity the bound (DEV_ASSERT in dev).
 * Every caller passes an integer in play, so no double is boxed across the call.
 */
function quantizeCount(x: number, max: number): number {
  if (!Number.isFinite(x)) DEV_ASSERT(false, "PlayerState counter must be finite", x);
  if (!(x > 0)) return 0;
  if (x >= max) return max;
  return x | 0;
}

/** armor: masked to ARMOR_MASK (truncating toward zero); NaN and ±Infinity become 0. */
function quantizeArmor(x: number): number {
  if (!Number.isFinite(x)) DEV_ASSERT(false, "armor must be finite", x);
  return x & ARMOR_MASK;
}

/** climbYaw: masked to 8 bits, as an angle wraps; NaN and ±Infinity become 0. */
function quantizeClimbYaw(x: number): number {
  if (!Number.isFinite(x)) DEV_ASSERT(false, "climbYaw must be finite", x);
  return x & 0xff;
}

/**
 * End-of-tick quantization of the whole state, in place (docs/05 §4.1), on client and server
 * alike so a correct prediction matches the server bit for bit. Idempotent, never yields −0, and
 * every field ends in the range its codec carries, except pitch:
 * - origin and velocity: math/quant grids and clamps;
 * - angles `& 0xFFFF` and flags `& PMF_MASK` (wrap, truncating toward zero). Pitch is only
 *   masked, not clamped (the frozen D-016 vectors pin that): it stays within ±PITCH_LIMIT_U16,
 *   which the codec requires, because pmove copies a sanitized cmd pitch, and any other path that
 *   sets it (spawn, teleport) must clamp it with clampPitchU16;
 * - groundEntity to [ENTITY_NONE, ENTITY_WORLD] and waterLevel to 0..3, truncating;
 * - stamina to the nearest hundredth in 0..65535 (a continuous quantity, so it rounds);
 * - the v4 fields (M4 design §2.2) into their widths: armor and climbYaw masked; health,
 *   wallJumps, submerged and the five timers truncated and clamped to 0..2^bits − 1; climbHeight
 *   truncated and clamped to the i12 range;
 * - the canonical rule: climbHeight and climbYaw are 0 whenever CLIMBING is clear, whatever path
 *   cleared it (a drop, a death, a spawn), so a quantized state is always one the encoder takes.
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
  ps.wallJumps = quantizeCount(ps.wallJumps, WALL_JUMPS_MAX);
  ps.health = quantizeCount(ps.health, HEALTH_Q_MAX);
  ps.armor = quantizeArmor(ps.armor);
  ps.submerged = quantizeCount(ps.submerged, SUBMERGED_MAX);
  if ((ps.flags & PMF_CLIMBING) !== 0) {
    // climbHeight truncated toward zero into the i12 range (−0 becomes 0, NaN 0). Inline: a call
    // would box a fractional double under native ESM when CLIMBING changes between ticks.
    const h = ps.climbHeight;
    if (!Number.isFinite(h)) DEV_ASSERT(false, "climbHeight must be finite", h);
    ps.climbHeight = Number.isNaN(h)
      ? 0
      : Math.max(CLIMB_HEIGHT_Q_MIN, Math.min(CLIMB_HEIGHT_Q_MAX, h)) | 0;
    ps.climbYaw = quantizeClimbYaw(ps.climbYaw);
  } else {
    ps.climbHeight = 0;
    ps.climbYaw = 0;
  }
  ps.regenDelay = quantizeCount(ps.regenDelay, REGEN_DELAY_MAX);
  ps.kickCooldown = quantizeCount(ps.kickCooldown, KICK_COOLDOWN_MAX);
  ps.regrab = quantizeCount(ps.regrab, REGRAB_MAX);
  ps.waterJump = quantizeCount(ps.waterJump, WATER_JUMP_MAX);
  ps.bandage = quantizeCount(ps.bandage, BANDAGE_MAX);
  return ps;
}

/**
 * The state a spawn starts from (M4 design §2.2), in place: at rest, airborne until the caller's
 * ground trace says otherwise, full health and stamina, `armor` (ARMOR_* bits; the server's
 * `sv_spawnVest` until M6 loadouts), every flag, counter and timer 0. Origin and view are the
 * caller's (a spawn point, a teleport, a scenario's placement); the caller quantizes. The match's
 * spawn and the scenarios' placePlayer both go through it, so a field PlayerState gains is reset
 * by both (the field guard checks it).
 */
export function resetPlayerStateForSpawn(ps: PlayerState, armor: number): PlayerState {
  ps.velocity.fill(0);
  ps.flags = 0;
  ps.groundEntity = ENTITY_NONE;
  ps.waterLevel = 0;
  ps.stamina = PLAYER_STAMINA_FULL;
  ps.wallJumps = 0;
  ps.health = PLAYER_HEALTH_MAX;
  ps.armor = armor & ARMOR_MASK;
  ps.submerged = 0;
  ps.climbHeight = 0;
  ps.climbYaw = 0;
  ps.regenDelay = 0;
  ps.kickCooldown = 0;
  ps.regrab = 0;
  ps.waterJump = 0;
  ps.bandage = 0;
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
