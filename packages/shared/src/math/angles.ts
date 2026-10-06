import { sinCosU16 } from "./dtrig";
import { toSigned16 } from "./quant";
import type { Vec3 } from "./vec3";

/**
 * View angles in u16 units (docs/03 §2): yaw turns about +Z with 0 facing +X; positive pitch
 * looks down. Pitch is clamped to ±89°.
 */

/** floor(89 · 65536 / 360): the largest whole unit that stays within 89°. */
export const PITCH_LIMIT_U16 = 16201;

/** Clamps a u16 pitch to ±PITCH_LIMIT_U16 and returns it as a u16 again. */
export function clampPitchU16(pitch: number): number {
  const s = toSigned16(pitch);
  if (s > PITCH_LIMIT_U16) return PITCH_LIMIT_U16;
  if (s < -PITCH_LIMIT_U16) return -PITCH_LIMIT_U16 & 0xffff;
  return s & 0xffff;
}

/** sin/cos of yaw then pitch: filled through an out-parameter, so no double result is boxed. */
const sinCos = new Float64Array(4);

/**
 * Unit view basis from u16 angles: forward = (cp·cy, cp·sy, −sp), right = (sy, −cy, 0),
 * up = (sp·cy, sp·sy, cp), from sinU16/cosU16. Negations are written `0 − v` so no component is
 * ever −0.
 */
export function angleVectors(
  yaw: number,
  pitch: number,
  forward: Vec3,
  right: Vec3,
  up: Vec3,
): void {
  const t = sinCos;
  sinCosU16(yaw, t, 0);
  sinCosU16(pitch, t, 2);
  const sy = t[0] as number;
  const cy = t[1] as number;
  const sp = t[2] as number;
  const cp = t[3] as number;
  forward[0] = cp * cy + 0;
  forward[1] = cp * sy + 0;
  forward[2] = 0 - sp;
  right[0] = sy;
  right[1] = 0 - cy;
  right[2] = 0;
  up[0] = sp * cy + 0;
  up[1] = sp * sy + 0;
  up[2] = cp;
}
