import { afterEach, describe, expect, it } from "vitest";
import { DevAssertError, setDevAsserts } from "../../src/debug/assert";
import { Mulberry32 } from "../../src/rng/mulberry32";

/** Independent BigInt version of the published algorithm, to cross-check the Math.imul one. */
function referenceSequence(seed: number, count: number): number[] {
  const M = 0xffffffffn;
  const mul = (a: bigint, b: bigint) => (a * b) & M;
  let state = BigInt(seed >>> 0);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    state = (state + 0x6d2b79f5n) & M;
    let z = state;
    z = mul(z ^ (z >> 15n), z | 1n);
    z = z ^ ((z + mul(z ^ (z >> 7n), z | 61n)) & M);
    out.push(Number(z ^ (z >> 14n)));
  }
  return out;
}

describe("Mulberry32", () => {
  afterEach(() => setDevAsserts(true));

  it.each([0, 1, 42, 0x9e3779b9, 0xffffffff])(
    "matches the reference sequence for seed %i",
    (seed) => {
      const rng = new Mulberry32(seed);
      const got = Array.from({ length: 1000 }, () => rng.nextU32());
      expect(got).toEqual(referenceSequence(seed, 1000));
    },
  );

  it("is deterministic and reseedable, with readable state", () => {
    const a = new Mulberry32(123);
    const first = [a.nextU32(), a.nextU32(), a.nextU32()];
    a.reseed(123);
    expect([a.nextU32(), a.nextU32(), a.nextU32()]).toEqual(first);
    const b = new Mulberry32(a.state);
    expect(b.nextU32()).toBe(a.nextU32());
    expect(new Mulberry32(-1).state).toBe(0xffffffff);
  });

  it("returns u32 values and floats in [0, 1)", () => {
    const rng = new Mulberry32(9);
    let sum = 0;
    for (let i = 0; i < 20000; i++) {
      const u = rng.nextU32();
      expect(Number.isInteger(u) && u >= 0 && u <= 0xffffffff).toBe(true);
      const x = rng.nextFloat();
      expect(x >= 0 && x < 1).toBe(true);
      sum += x;
    }
    expect(sum / 20000).toBeCloseTo(0.5, 1);
  });

  it("maps the extreme u32 values exactly", () => {
    const rng = new Mulberry32(0);
    rng.nextU32 = () => 0xffffffff;
    expect(rng.nextFloat()).toBe(1 - 2 ** -32);
    expect(rng.nextInt(0x200000)).toBe(0x1fffff);
    rng.nextU32 = () => 0;
    expect(rng.nextInt(7)).toBe(0);
  });

  it("maps a u32 to [0, n) by its high part (floor(u·n / 2^32)), not by u % n", () => {
    const rng = new Mulberry32(0);
    rng.nextU32 = () => 0x80000000;
    expect(rng.nextInt(3)).toBe(1); // 0x80000000 % 3 would be 2
    expect(rng.nextInt(100)).toBe(50);
    rng.nextU32 = () => 0x55555556;
    expect(rng.nextInt(3)).toBe(1);
    rng.nextU32 = () => 0x55555555;
    expect(rng.nextInt(3)).toBe(0);
  });

  it("draws integers in [0, n) covering every value", () => {
    const rng = new Mulberry32(77);
    const seen = new Array<number>(6).fill(0);
    for (let i = 0; i < 6000; i++) {
      const k = rng.nextInt(6);
      expect(Number.isInteger(k) && k >= 0 && k < 6).toBe(true);
      seen[k] = (seen[k] ?? 0) + 1;
    }
    for (const count of seen) expect(count).toBeGreaterThan(800);
    expect(rng.nextInt(1)).toBe(0);
  });

  it("asserts the nextInt range", () => {
    const rng = new Mulberry32(1);
    expect(() => rng.nextInt(0)).toThrow(DevAssertError);
    expect(() => rng.nextInt(2.5)).toThrow(DevAssertError);
    expect(() => rng.nextInt(0x200001)).toThrow(DevAssertError);
  });
});
