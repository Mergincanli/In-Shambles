import { clampPitchU16 } from "../math/angles";
import { TICK_MAX } from "../time";

/**
 * Button bits of UserCmd.buttons (docs/05 §3.4, u16 on the wire). Bits 12..15 are spare.
 * docs/05 also lists "kick-eligible", which reads as state derived from the player and weapon
 * rather than an input; it is left out until the kick lands in M4 (M1 plan, open question 1).
 */
export const BUTTON_ATTACK = 1 << 0;
export const BUTTON_JUMP = 1 << 1;
export const BUTTON_CROUCH = 1 << 2;
export const BUTTON_SPRINT = 1 << 3;
export const BUTTON_WALK = 1 << 4;
export const BUTTON_USE = 1 << 5;
export const BUTTON_RELOAD = 1 << 6;
export const BUTTON_BANDAGE = 1 << 7;
export const BUTTON_FIRE_MODE = 1 << 8;
export const BUTTON_ZOOM_IN = 1 << 9;
export const BUTTON_ZOOM_RESET = 1 << 10;
export const BUTTON_DROP = 1 << 11;
export const BUTTON_MASK = 0xfff;

/** forward/right/up range. The i8 on the wire can carry −128; ±127 keeps the axes symmetric. */
export const MOVE_AXIS_MAX = 127;

/** docs/04 §9 (FACT rules): primary, secondary, sidearm, grenade, item1, item2, item3. */
export const LOADOUT_SLOT_COUNT = 7;

/**
 * weaponSlot indexes the loadout slots plus the always-carried knife (docs/04 §2). Which index is
 * which is settled with weapon switching; sanitize only bounds it.
 */
export const WEAPON_SLOT_COUNT = LOADOUT_SLOT_COUNT + 1;

/**
 * One tick of player input (docs/05 §3.4). Every field holds an integer once sanitized.
 * fireSubtick and viewInterpTick join with lag compensation (M6).
 */
export class UserCmd {
  tick = 0;
  /** BUTTON_* bits. */
  buttons = 0;
  /** −127..127 each. */
  forward = 0;
  right = 0;
  up = 0;
  /** u16 angle units; pitch within ±PITCH_LIMIT_U16. */
  yaw = 0;
  pitch = 0;
  weaponSlot = 0;
}

export function copyUserCmd(dst: UserCmd, src: UserCmd): UserCmd {
  dst.tick = src.tick;
  dst.buttons = src.buttons;
  dst.forward = src.forward;
  dst.right = src.right;
  dst.up = src.up;
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  dst.weaponSlot = src.weaponSlot;
  return dst;
}

/** Truncates toward zero into [lo, hi] (lo ≤ 0 ≤ hi); NaN becomes 0 and −0 becomes +0. */
function clampInt(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return 0;
  if (x <= lo) return lo;
  if (x >= hi) return hi;
  return x | 0;
}

/**
 * Forces a cmd from the network into range, in place. Client input is untrusted rather than a
 * bug, so this never asserts or throws: NaN becomes 0, and the masks take ToInt32 of anything else.
 */
export function sanitizeUserCmd(cmd: UserCmd): UserCmd {
  cmd.tick = clampInt(cmd.tick, 0, TICK_MAX);
  cmd.buttons &= BUTTON_MASK;
  cmd.forward = clampInt(cmd.forward, -MOVE_AXIS_MAX, MOVE_AXIS_MAX);
  cmd.right = clampInt(cmd.right, -MOVE_AXIS_MAX, MOVE_AXIS_MAX);
  cmd.up = clampInt(cmd.up, -MOVE_AXIS_MAX, MOVE_AXIS_MAX);
  cmd.yaw &= 0xffff;
  cmd.pitch = clampPitchU16(cmd.pitch);
  cmd.weaponSlot = clampInt(cmd.weaponSlot, 0, WEAPON_SLOT_COUNT - 1);
  return cmd;
}
