import { describe, expect, it } from "vitest";
import { PITCH_LIMIT_U16 } from "../../src/math/angles";
import {
  BUTTON_ATTACK,
  BUTTON_BANDAGE,
  BUTTON_CROUCH,
  BUTTON_DROP,
  BUTTON_FIRE_MODE,
  BUTTON_JUMP,
  BUTTON_MASK,
  BUTTON_RELOAD,
  BUTTON_SPRINT,
  BUTTON_USE,
  BUTTON_WALK,
  BUTTON_ZOOM_IN,
  BUTTON_ZOOM_RESET,
  copyUserCmd,
  LOADOUT_SLOT_COUNT,
  MOVE_AXIS_MAX,
  sanitizeUserCmd,
  UserCmd,
  WEAPON_SLOT_COUNT,
} from "../../src/sim/usercmd";
import { TICK_MAX } from "../../src/time";

const FIELDS = ["tick", "buttons", "forward", "right", "up", "yaw", "pitch", "weaponSlot"] as const;
type Field = (typeof FIELDS)[number];

function values(cmd: UserCmd): unknown[] {
  return FIELDS.map((f) => (Object.is(cmd[f], -0) ? "-0" : cmd[f]));
}

/** Sanitizes a fresh cmd with only `field` set to `x`, and returns that field. */
function sanitized(field: Field, x: number): number {
  const cmd = new UserCmd();
  cmd[field] = x;
  return sanitizeUserCmd(cmd)[field];
}

const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

describe("UserCmd", () => {
  it("declares the docs/05 §3.4 fields in order, all zero", () => {
    expect(Object.keys(new UserCmd())).toEqual(FIELDS);
    expect(values(new UserCmd())).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("has the 12 docs/05 §3.4 buttons as bits 0..11 (no kick-eligible yet)", () => {
    const buttons = [
      BUTTON_ATTACK,
      BUTTON_JUMP,
      BUTTON_CROUCH,
      BUTTON_SPRINT,
      BUTTON_WALK,
      BUTTON_USE,
      BUTTON_RELOAD,
      BUTTON_BANDAGE,
      BUTTON_FIRE_MODE,
      BUTTON_ZOOM_IN,
      BUTTON_ZOOM_RESET,
      BUTTON_DROP,
    ];
    expect(buttons).toEqual(buttons.map((_, i) => 1 << i));
    expect(buttons.reduce((m, b) => m | b, 0)).toBe(BUTTON_MASK);
    expect(BUTTON_MASK).toBeLessThan(0x10000);
  });

  it("copies every field", () => {
    const src = new UserCmd();
    FIELDS.forEach((f, i) => {
      src[f] = i + 1;
    });
    const dst = new UserCmd();
    expect(copyUserCmd(dst, src)).toBe(dst);
    expect(values(dst)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("sanitizeUserCmd", () => {
  it("leaves a valid cmd untouched and returns it", () => {
    const cmd = new UserCmd();
    cmd.tick = 3600;
    cmd.buttons = BUTTON_JUMP | BUTTON_SPRINT;
    cmd.forward = 127;
    cmd.right = -127;
    cmd.up = 5;
    cmd.yaw = 40000;
    cmd.pitch = 65536 - PITCH_LIMIT_U16;
    cmd.weaponSlot = 3;
    const before = values(cmd);
    expect(sanitizeUserCmd(cmd)).toBe(cmd);
    expect(values(cmd)).toEqual(before);
  });

  it.each(["forward", "right", "up"] as const)("clamps %s to ±127 integers", (axis) => {
    expect(MOVE_AXIS_MAX).toBe(127);
    const cases: [number, number][] = [
      [0, 0],
      [127, 127],
      [128, 127],
      [1e9, 127],
      [-127, -127],
      [-128, -127],
      [-1e9, -127],
      [12.7, 12],
      [-12.7, -12],
      [-0.5, 0],
      [-0, 0],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 127],
      [Number.NEGATIVE_INFINITY, -127],
    ];
    for (const [x, q] of cases) expect(Object.is(sanitized(axis, x), q), `${x}`).toBe(true);
  });

  it("wraps yaw to u16", () => {
    const cases: [number, number][] = [
      [0, 0],
      [65535, 65535],
      [65536, 0],
      [-1, 65535],
      [70000.9, 70000 - 65536],
      [-0, 0],
    ];
    for (const [x, q] of cases) expect(Object.is(sanitized("yaw", x), q), `${x}`).toBe(true);
    for (const x of NON_FINITE) expect(sanitized("yaw", x)).toBe(0);
  });

  it("clamps pitch to ±PITCH_LIMIT_U16 as a u16", () => {
    const down = PITCH_LIMIT_U16;
    const up = 65536 - PITCH_LIMIT_U16;
    const cases: [number, number][] = [
      [0, 0],
      [down, down],
      [down + 1, down],
      [32767, down],
      [32768, up],
      [up, up],
      [up - 1, up],
      [65535, 65535],
      [-1, 65535],
      [-down, up],
      [-down - 1, up],
      [65536 + 5, 5],
      [-0, 0],
    ];
    for (const [x, q] of cases) expect(Object.is(sanitized("pitch", x), q), `${x}`).toBe(true);
    for (const x of NON_FINITE) expect(sanitized("pitch", x)).toBe(0);
  });

  it("masks unknown button bits", () => {
    expect(sanitized("buttons", BUTTON_MASK)).toBe(BUTTON_MASK);
    expect(sanitized("buttons", 0xffff)).toBe(BUTTON_MASK);
    expect(sanitized("buttons", 1 << 12)).toBe(0);
    expect(sanitized("buttons", -1)).toBe(BUTTON_MASK);
    expect(sanitized("buttons", BUTTON_ATTACK | (1 << 15))).toBe(BUTTON_ATTACK);
    expect(sanitized("buttons", BUTTON_DROP + 0.5)).toBe(BUTTON_DROP);
    for (const x of NON_FINITE) expect(sanitized("buttons", x)).toBe(0);
  });

  it("clamps weaponSlot to the knife plus the docs/04 §9 loadout slots", () => {
    expect(LOADOUT_SLOT_COUNT).toBe(7);
    expect(WEAPON_SLOT_COUNT).toBe(8);
    const top = WEAPON_SLOT_COUNT - 1;
    const cases: [number, number][] = [
      [0, 0],
      [top, top],
      [top + 1, top],
      [255, top],
      [-1, 0],
      [2.9, 2],
      [-0, 0],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, top],
      [Number.NEGATIVE_INFINITY, 0],
    ];
    for (const [x, q] of cases) expect(Object.is(sanitized("weaponSlot", x), q), `${x}`).toBe(true);
  });

  it("makes tick a non-negative integer up to TICK_MAX", () => {
    expect(TICK_MAX).toBe(2 ** 30 - 1);
    const cases: [number, number][] = [
      [0, 0],
      [1, 1],
      [TICK_MAX, TICK_MAX],
      [TICK_MAX + 1, TICK_MAX],
      [2 ** 32, TICK_MAX],
      [-1, 0],
      [99.9, 99],
      [-0, 0],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, TICK_MAX],
      [Number.NEGATIVE_INFINITY, 0],
    ];
    for (const [x, q] of cases) expect(Object.is(sanitized("tick", x), q), `${x}`).toBe(true);
  });

  it("never throws, and leaves only integers in range", () => {
    const junk = [Number.NaN, -1e300, -129.5, -0, 0.5, 1e9, 2 ** 40, Number.POSITIVE_INFINITY];
    for (const x of junk) {
      const cmd = new UserCmd();
      for (const f of FIELDS) cmd[f] = x;
      expect(() => sanitizeUserCmd(cmd)).not.toThrow();
      for (const v of values(cmd)) expect(Number.isInteger(v)).toBe(true);
      expect(cmd.tick).toBeGreaterThanOrEqual(0);
      expect(cmd.tick).toBeLessThanOrEqual(TICK_MAX);
      expect(cmd.buttons & ~BUTTON_MASK).toBe(0);
      for (const a of [cmd.forward, cmd.right, cmd.up])
        expect(Math.abs(a)).toBeLessThanOrEqual(127);
      expect(cmd.yaw >>> 16).toBe(0);
      expect(cmd.pitch >>> 16).toBe(0);
      expect(Math.abs((cmd.pitch << 16) >> 16)).toBeLessThanOrEqual(PITCH_LIMIT_U16);
      expect(cmd.weaponSlot).toBeGreaterThanOrEqual(0);
      expect(cmd.weaponSlot).toBeLessThan(WEAPON_SLOT_COUNT);
      // Idempotent.
      const again = copyUserCmd(new UserCmd(), cmd);
      expect(values(sanitizeUserCmd(again))).toEqual(values(cmd));
    }
  });
});
