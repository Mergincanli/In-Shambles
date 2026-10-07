import { describe, expect, it } from "vitest";
import { DevAssertError } from "../../src/debug/assert";
import { cosU16, dcos, dsin, sinCosU16, sinU16 } from "../../src/math/dtrig";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { nextAfter, ulpDistance } from "../helpers/f64";

// Math.sin/cos are only the reference here; src never calls them (D-016). V8's are within 1 ulp,
// so "within 2 ulp of Math.sin" bounds our own error near 1–3 ulp. Next to zeros of sin/cos the
// two-part reduction only promises absolute accuracy (|k|·2^-87, below 1e-21), so tiny results
// are held to that bound instead of an ulp count.
const NEAR_ZERO = 1e-3;
const NEAR_ZERO_ABS = 1e-21;
function expectClose(actual: number, reference: number, x: number) {
  const ok =
    ulpDistance(actual, reference) <= 2 ||
    (Math.abs(reference) < NEAR_ZERO && Math.abs(actual - reference) <= NEAR_ZERO_ABS);
  if (!ok) expect.fail(`x=${x}: got ${actual}, reference ${reference}`);
}

describe("dsin / dcos", () => {
  it("stay within 2 ulp of Math.sin/cos over [-1e5, 1e5]", () => {
    const rng = new Mulberry32(0x5eed);
    for (let i = 0; i < 60000; i++) {
      const range = i % 3 === 0 ? 4 : i % 3 === 1 ? 1000 : 99999.99;
      const x = (rng.nextFloat() * 2 - 1) * range;
      expectClose(dsin(x), Math.sin(x), x);
      expectClose(dcos(x), Math.cos(x), x);
    }
  });

  it("stay within 2 ulp, or 1e-21 absolute next to zeros, near multiples of π/2 and at reduction boundaries", () => {
    for (let k = -63600; k <= 63600; k += 37) {
      const x = k * (Math.PI / 2);
      const half = (k + 0.5) * (Math.PI / 2);
      for (const y of [x, nextAfter(x), nextAfter(x, -1), x + 1e-9, half, nextAfter(half)]) {
        if (Math.abs(y) >= 1e5) continue;
        expectClose(dsin(y), Math.sin(y), y);
        expectClose(dcos(y), Math.cos(y), y);
      }
    }
  });

  it("are exact or nearly so at simple points", () => {
    expect(dsin(0)).toBe(0);
    expect(dcos(0)).toBe(1);
    expect(dsin(1e-300)).toBe(1e-300);
    expect(dsin(Number.MIN_VALUE)).toBe(Number.MIN_VALUE);
    expect(ulpDistance(dsin(Math.PI / 6), 0.5)).toBeLessThanOrEqual(1);
    expect(ulpDistance(dcos(Math.PI / 3), 0.5)).toBeLessThanOrEqual(2);
    expect(dsin(Math.PI / 2)).toBe(1);
  });

  it("assert the argument range and finiteness", () => {
    expect(() => dsin(1e5)).toThrow(DevAssertError);
    expect(() => dcos(-1e5)).toThrow(DevAssertError);
    expect(() => dsin(Number.NaN)).toThrow(DevAssertError);
    expect(() => dcos(Number.POSITIVE_INFINITY)).toThrow(DevAssertError);
    expect(() => dsin(99999.99)).not.toThrow();
  });
});

describe("sinU16 / cosU16", () => {
  it("are exact at the cardinal angles, with +0 rather than -0", () => {
    expect(Object.is(sinU16(0), 0)).toBe(true);
    expect(sinU16(16384)).toBe(1);
    expect(Object.is(sinU16(32768), 0)).toBe(true);
    expect(sinU16(49152)).toBe(-1);
    expect(cosU16(0)).toBe(1);
    expect(Object.is(cosU16(16384), 0)).toBe(true);
    expect(cosU16(32768)).toBe(-1);
    expect(Object.is(cosU16(49152), 0)).toBe(true);
  });

  it("wrap any integer angle to u16", () => {
    expect(sinU16(65536 + 16384)).toBe(1);
    expect(sinU16(-16384)).toBe(-1);
    expect(cosU16(-32768)).toBe(-1);
  });

  it("sinCosU16 writes exactly sinU16 and cosU16 for every integer angle, wrapped ones included", () => {
    const out = new Float64Array(5);
    for (let a = -70000; a < 140000; a++) {
      sinCosU16(a, out, 2);
      if (!Object.is(out[2], sinU16(a)) || !Object.is(out[3], cosU16(a))) {
        expect([a, out[2], out[3]]).toEqual([a, sinU16(a), cosU16(a)]);
      }
    }
    expect([out[0], out[1], out[4]]).toEqual([0, 0, 0]);
  });

  it("are exactly odd, even and symmetric over all 65536 angles", () => {
    for (let a = 0; a < 65536; a++) {
      const s = sinU16(a);
      const c = cosU16(a);
      if (Object.is(s, -0) || Object.is(c, -0)) expect.fail(`-0 at ${a}`);
      if (sinU16(-a) !== 0 - s) expect.fail(`sin not odd at ${a}`);
      if (cosU16(-a) !== c) expect.fail(`cos not even at ${a}`);
      if (sinU16(32768 - a) !== s) expect.fail(`sin(180° - a) != sin(a) at ${a}`);
      if (cosU16(a + 32768) !== 0 - c) expect.fail(`cos(a + 180°) != -cos(a) at ${a}`);
      if (Math.abs(s * s + c * c - 1) > 4e-16) expect.fail(`sin² + cos² != 1 at ${a}`);
    }
  });

  it("match Math.sin over the first quadrant, where the table is built", () => {
    // Same arguments as the table, so only the polynomial error counts; the other quadrants
    // follow by the exact symmetries above.
    const step = Math.PI / 32768;
    for (let a = 0; a <= 16384; a++) {
      const reference = a <= 8192 ? Math.sin(a * step) : Math.cos((16384 - a) * step);
      expectClose(sinU16(a), reference, a);
    }
  });

  it("match Math.sin around the full turn within rounding of the angle itself", () => {
    for (let a = 0; a < 65536; a++) {
      const x = (a * Math.PI) / 32768;
      if (Math.abs(sinU16(a) - Math.sin(x)) > 1e-15) expect.fail(`sin at ${a}`);
      if (Math.abs(cosU16(a) - Math.cos(x)) > 1e-15) expect.fail(`cos at ${a}`);
    }
  });

  it("give equal sine and cosine at 45°", () => {
    expect(sinU16(8192)).toBe(cosU16(8192));
    expect(ulpDistance(sinU16(8192), Math.SQRT1_2)).toBeLessThanOrEqual(1);
  });
});
