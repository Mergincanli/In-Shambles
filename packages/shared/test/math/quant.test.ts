import { afterEach, describe, expect, it } from "vitest";
import { DevAssertError, setDevAsserts } from "../../src/debug/assert";
import {
  degreesToU16,
  ORIGIN_LIMIT,
  ORIGIN_SCALE,
  quantizeOrigin,
  quantizeOriginVec3,
  quantizeStaminaHundredths,
  quantizeVelocity,
  quantizeVelocityVec3,
  toSigned16,
  u16ToDegrees,
  VELOCITY_LIMIT,
  VELOCITY_SCALE,
} from "../../src/math/quant";
import { vec3 } from "../../src/math/vec3";
import { Mulberry32 } from "../../src/rng/mulberry32";

describe("quantizeOrigin", () => {
  afterEach(() => setDevAsserts(true));

  it.each([
    [0, 0],
    [1, 1],
    [0.03125, 0.03125],
    [0.04, 0.03125],
    [0.047, 0.0625],
    [1 / 64, 1 / 32],
    [-1 / 64, 0],
    [3 / 64, 2 / 32],
    [-3 / 64, -1 / 32],
    [100.01, 100],
    [-100.02, -100.03125],
  ])("q(%f) = %f", (x, q) => {
    expect(quantizeOrigin(x)).toBe(q);
  });

  it("rounds halves toward +Infinity, so q(-x) differs from -q(x) at halves", () => {
    expect(quantizeOrigin(1 / 64)).toBe(1 / 32);
    expect(quantizeOrigin(-1 / 64)).toBe(0);
    expect(quantizeOrigin(5 / 64)).toBe(3 / 32);
    expect(quantizeOrigin(-5 / 64)).toBe(-2 / 32);
  });

  it("never returns -0", () => {
    for (const x of [-0, -1e-9, -1 / 128, -1 / 64, -Number.MIN_VALUE]) {
      expect(Object.is(quantizeOrigin(x), 0)).toBe(true);
      expect(Object.is(quantizeVelocity(x), 0)).toBe(true);
    }
  });

  it("clamps to the codec range", () => {
    // docs/05 §4.1: origin on a 1/32 u grid, velocity on a 1/16 u/s grid.
    expect(ORIGIN_SCALE).toBe(32);
    expect(VELOCITY_SCALE).toBe(16);
    expect(quantizeOrigin(ORIGIN_LIMIT + 5)).toBe(ORIGIN_LIMIT);
    expect(quantizeOrigin(-ORIGIN_LIMIT - 5)).toBe(-ORIGIN_LIMIT);
    expect(quantizeOrigin(1e300)).toBe(16384);
    expect(VELOCITY_LIMIT).toBe((2 ** 19 - 1) / 16);
    expect(quantizeVelocity(1e9)).toBe(VELOCITY_LIMIT);
    expect(quantizeVelocity(-1e9)).toBe(-VELOCITY_LIMIT);
    expect(quantizeVelocity(VELOCITY_LIMIT)).toBe(VELOCITY_LIMIT);
    expect(VELOCITY_LIMIT * 16).toBe(524287);
  });

  it("asserts finite input in dev; maps NaN to 0 and clamps Infinity in prod", () => {
    expect(() => quantizeOrigin(Number.NaN)).toThrow(DevAssertError);
    expect(() => quantizeVelocity(Number.POSITIVE_INFINITY)).toThrow(DevAssertError);
    expect(() => quantizeStaminaHundredths(Number.NaN)).toThrow(DevAssertError);
    setDevAsserts(false);
    expect(quantizeOrigin(Number.NaN)).toBe(0);
    expect(quantizeVelocity(Number.NaN)).toBe(0);
    expect(quantizeStaminaHundredths(Number.NaN)).toBe(0);
    expect(quantizeOrigin(Number.POSITIVE_INFINITY)).toBe(ORIGIN_LIMIT);
    expect(quantizeVelocity(Number.NEGATIVE_INFINITY)).toBe(-VELOCITY_LIMIT);
  });

  it("is idempotent and lands on the grid", () => {
    const rng = new Mulberry32(7);
    for (let i = 0; i < 20000; i++) {
      const x = (rng.nextFloat() * 2 - 1) * 20000;
      const q = quantizeOrigin(x);
      expect(quantizeOrigin(q)).toBe(q);
      expect(Number.isInteger(q * 32)).toBe(true);
      if (Math.abs(x) <= ORIGIN_LIMIT) expect(Math.abs(q - x)).toBeLessThanOrEqual(1 / 64);
      const v = quantizeVelocity(x);
      expect(quantizeVelocity(v)).toBe(v);
      expect(Number.isInteger(v * 16)).toBe(true);
      expect(Math.abs(v - x)).toBeLessThanOrEqual(1 / 32);
    }
  });

  it("quantizes vectors in place", () => {
    const o = vec3(1.01, -0.001, 99999);
    expect(quantizeOriginVec3(o)).toBe(o);
    expect(Array.from(o)).toEqual([1, 0, 16384]);
    expect(Object.is(o[1], 0)).toBe(true);
    const v = vec3(320.03, -0.02, -1 / 32);
    quantizeVelocityVec3(v);
    expect(Array.from(v)).toEqual([320, 0, 0]);
    expect(Object.is(v[2], 0)).toBe(true);
  });
});

describe("quantizeStaminaHundredths", () => {
  it.each([
    [0, 0],
    [10000, 10000],
    [9999.5, 10000],
    [9999.49, 9999],
    [-5, 0],
    [70000, 65535],
    [65535, 65535],
    [0.4, 0],
  ])("q(%f) = %i", (x, q) => {
    expect(quantizeStaminaHundredths(x)).toBe(q);
  });
});

describe("u16 angles", () => {
  it.each([
    [0, 0],
    [90, 16384],
    [180, 32768],
    [270, 49152],
    [360, 0],
    [-90, 49152],
    [45, 8192],
    [89, 16202],
    [720.5, 91],
  ])("degreesToU16(%f) = %i", (deg, a) => {
    expect(degreesToU16(deg)).toBe(a);
  });

  it("converts back to degrees for display", () => {
    expect(u16ToDegrees(16384)).toBe(90);
    expect(u16ToDegrees(49152)).toBe(270);
    expect(u16ToDegrees(65536 + 8192)).toBe(45);
  });

  it("reads a u16 angle as signed 16 bits", () => {
    expect(toSigned16(0)).toBe(0);
    expect(toSigned16(32767)).toBe(32767);
    expect(toSigned16(32768)).toBe(-32768);
    expect(toSigned16(65535)).toBe(-1);
    expect(toSigned16(49335)).toBe(-16201);
    expect(toSigned16(65536 + 5)).toBe(5);
  });
});
