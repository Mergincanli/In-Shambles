import { PITCH_LIMIT_U16 } from "../math/angles";
import { ORIGIN_LIMIT, ORIGIN_SCALE, toSigned16, VELOCITY_SCALE } from "../math/quant";
import { ENTITY_NONE, ENTITY_WORLD } from "../sim/entity";
import type { PlayerState } from "../sim/playerState";
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
 * | flags | 10 | PMF_* bits |
 * | groundEntity + 1 | 16 | 0 (ENTITY_NONE) … 32768 (ENTITY_WORLD) |
 * | waterLevel | 2 | 0–3 |
 * | stamina | 16 | hundredths |
 *
 * 199 bits. New PlayerState fields go at the end, here and in docs/05 §3.6, with a
 * PROTOCOL_VERSION bump.
 */
export const PLAYER_STATE_BITS = 199;

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
  w.writeBits(ps.flags, 10);
  const g = ps.groundEntity;
  if ((g | 0) !== g || g < ENTITY_NONE || g > ENTITY_WORLD) w.fail();
  w.writeBits(g + 1, 16);
  w.writeBits(ps.waterLevel, 2);
  w.writeBits(ps.stamina, 16);
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
  out.flags = r.readBits(10);
  const g = r.readBits(16);
  if (g > ENTITY_WORLD + 1) ok = false;
  out.groundEntity = g - 1;
  out.waterLevel = r.readBits(2);
  out.stamina = r.readBits(16);
  return ok && !r.error;
}
