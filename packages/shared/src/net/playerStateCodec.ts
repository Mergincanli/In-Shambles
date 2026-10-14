import { PITCH_LIMIT_U16 } from "../math/angles";
import { ORIGIN_LIMIT, ORIGIN_SCALE, toSigned16, VELOCITY_SCALE } from "../math/quant";
import { ENTITY_NONE, ENTITY_WORLD } from "../sim/entity";
import {
  ARMOR_BITS,
  BANDAGE_BITS,
  CLIMB_HEIGHT_BITS,
  CLIMB_YAW_BITS,
  HEALTH_BITS,
  KICK_COOLDOWN_BITS,
  type PlayerState,
  PMF_BITS,
  PMF_CLIMBING,
  REGEN_DELAY_BITS,
  REGRAB_BITS,
  SUBMERGED_BITS,
  WALL_JUMPS_BITS,
  WATER_JUMP_BITS,
} from "../sim/playerState";
import type { BitReader, BitWriter } from "./bitstream";

/**
 * The full PlayerState on the wire (docs/05 §3.6, D-026), in the grid units end-of-tick
 * quantization leaves it on (docs/05 §4.1), so a quantized state encodes exactly and decodes to
 * the same bits:
 *
 * | Field | Bits | Encoding |
 * |---|---|---|
 * | origin | 3 × 21 | signed 1/32 u, within ±16384 u (±2^19) |
 * | velocity | 3 × 20 | signed 1/16 u/s, within ±(2^19 − 1) |
 * | viewYaw, viewPitch | 16 + 16 | u16 units; pitch within ±PITCH_LIMIT_U16 |
 * | flags | 11 | PMF_* bits |
 * | groundEntity + 1 | 16 | 0 (ENTITY_NONE) … 32768 (ENTITY_WORLD) |
 * | waterLevel | 2 | 0–3 |
 * | stamina | 16 | hundredths |
 * | wallJumps | 3 | 0–7 |
 * | health | 14 | hundredths |
 * | armor | 2 | ARMOR_* bits |
 * | submerged | 11 | ticks |
 * | climbHeight | 12 | signed 1/32 u; 0 unless CLIMBING |
 * | climbYaw | 8 | yaw >> 8; 0 unless CLIMBING |
 * | regenDelay, kickCooldown, regrab, waterJump, bandage | 7, 6, 4, 6, 8 | ticks |
 *
 * 281 bits (protocol v4, M4 design §2.2, D-053). New PlayerState fields go at the end, here and in
 * docs/05 §3.6, with a PROTOCOL_VERSION bump.
 */
export const PLAYER_STATE_BITS = 281;

const ORIGIN_BITS = 21;
const VELOCITY_BITS = 20;
/** ±16384 u in 1/32 u units: one more than the i20 range holds, hence i21. */
const ORIGIN_Q_MAX = ORIGIN_LIMIT * ORIGIN_SCALE;
/** The i20 maximum; −2^19 is representable but outside the quantizer's clamp. */
const VELOCITY_Q_MAX = 524287;

function pitchInRange(pitch: number): boolean {
  const s = toSigned16(pitch);
  return s <= PITCH_LIMIT_U16 && s >= -PITCH_LIMIT_U16;
}

/** Whether the climb fields obey the canonical rule (0 unless CLIMBING; M4 design §2.2). */
export function climbFieldsCanonical(
  flags: number,
  climbHeight: number,
  climbYaw: number,
): boolean {
  return (flags & PMF_CLIMBING) !== 0 || (climbHeight === 0 && climbYaw === 0);
}

/** Writes the v4 fields after stamina (the writer refuses a value its width can't carry). */
function encodeV4Fields(w: BitWriter, ps: PlayerState): void {
  w.writeBits(ps.wallJumps, WALL_JUMPS_BITS);
  w.writeBits(ps.health, HEALTH_BITS);
  w.writeBits(ps.armor, ARMOR_BITS);
  w.writeBits(ps.submerged, SUBMERGED_BITS);
  if (!climbFieldsCanonical(ps.flags, ps.climbHeight, ps.climbYaw)) w.fail();
  w.writeSigned(ps.climbHeight, CLIMB_HEIGHT_BITS);
  w.writeBits(ps.climbYaw, CLIMB_YAW_BITS);
  w.writeBits(ps.regenDelay, REGEN_DELAY_BITS);
  w.writeBits(ps.kickCooldown, KICK_COOLDOWN_BITS);
  w.writeBits(ps.regrab, REGRAB_BITS);
  w.writeBits(ps.waterJump, WATER_JUMP_BITS);
  w.writeBits(ps.bandage, BANDAGE_BITS);
}

/**
 * Writes `ps`. A state off the grid or out of range (not quantized: a bug) sets the writer's
 * error flag rather than sending something the receiver would read differently. No allocation.
 */
export function encodePlayerState(w: BitWriter, ps: PlayerState): void {
  const o = ps.origin;
  for (let i = 0; i < 3; i++) {
    const q = (o[i] as number) * ORIGIN_SCALE;
    if (!(q >= -ORIGIN_Q_MAX && q <= ORIGIN_Q_MAX) || (q | 0) !== q) {
      w.fail();
      return;
    }
    w.writeSigned(q | 0, ORIGIN_BITS);
  }
  const v = ps.velocity;
  for (let i = 0; i < 3; i++) {
    const q = (v[i] as number) * VELOCITY_SCALE;
    if (!(q >= -VELOCITY_Q_MAX && q <= VELOCITY_Q_MAX) || (q | 0) !== q) {
      w.fail();
      return;
    }
    w.writeSigned(q | 0, VELOCITY_BITS);
  }
  w.writeBits(ps.viewYaw, 16);
  if (!pitchInRange(ps.viewPitch)) w.fail();
  w.writeBits(ps.viewPitch, 16);
  w.writeBits(ps.flags, PMF_BITS);
  const g = ps.groundEntity;
  if ((g | 0) !== g || g < ENTITY_NONE || g > ENTITY_WORLD) w.fail();
  w.writeBits(g + 1, 16);
  w.writeBits(ps.waterLevel, 2);
  w.writeBits(ps.stamina, 16);
  encodeV4Fields(w, ps);
}

/**
 * Reads a state into `out` and checks every range, so a true result is a state
 * quantizePlayerState leaves unchanged. On false (a short read or a value the encoder never
 * writes) `out` holds partial data and must be dropped. No allocation.
 */
export function decodePlayerState(r: BitReader, out: PlayerState): boolean {
  let ok = true;
  const o = out.origin;
  for (let i = 0; i < 3; i++) {
    const q = r.readSigned(ORIGIN_BITS);
    if (q > ORIGIN_Q_MAX || q < -ORIGIN_Q_MAX) ok = false;
    o[i] = q / ORIGIN_SCALE;
  }
  const v = out.velocity;
  for (let i = 0; i < 3; i++) {
    const q = r.readSigned(VELOCITY_BITS);
    if (q < -VELOCITY_Q_MAX) ok = false;
    v[i] = q / VELOCITY_SCALE;
  }
  out.viewYaw = r.readBits(16);
  const pitch = r.readBits(16);
  if (!pitchInRange(pitch)) ok = false;
  out.viewPitch = pitch;
  out.flags = r.readBits(PMF_BITS);
  const g = r.readBits(16);
  if (g > ENTITY_WORLD + 1) ok = false;
  out.groundEntity = g - 1;
  out.waterLevel = r.readBits(2);
  out.stamina = r.readBits(16);
  out.wallJumps = r.readBits(WALL_JUMPS_BITS);
  out.health = r.readBits(HEALTH_BITS);
  out.armor = r.readBits(ARMOR_BITS);
  out.submerged = r.readBits(SUBMERGED_BITS);
  out.climbHeight = r.readSigned(CLIMB_HEIGHT_BITS);
  out.climbYaw = r.readBits(CLIMB_YAW_BITS);
  if (!climbFieldsCanonical(out.flags, out.climbHeight, out.climbYaw)) ok = false;
  out.regenDelay = r.readBits(REGEN_DELAY_BITS);
  out.kickCooldown = r.readBits(KICK_COOLDOWN_BITS);
  out.regrab = r.readBits(REGRAB_BITS);
  out.waterJump = r.readBits(WATER_JUMP_BITS);
  out.bandage = r.readBits(BANDAGE_BITS);
  return ok && !r.error;
}
