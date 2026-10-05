import { describe, expect, it } from "vitest";
import {
  vec3,
  vec3Add,
  vec3Copy,
  vec3Cross,
  vec3DistanceSq,
  vec3Dot,
  vec3ExactEquals,
  vec3IsFinite,
  vec3Length,
  vec3LengthSq,
  vec3Madd,
  vec3Normalize,
  vec3Scale,
  vec3Set,
  vec3Sub,
} from "../../src/math/vec3";

const arr = (v: Float64Array) => Array.from(v);

describe("vec3", () => {
  it("is a Float64Array of length 3", () => {
    const v = vec3(1, 2, 3);
    expect(v).toBeInstanceOf(Float64Array);
    expect(arr(v)).toEqual([1, 2, 3]);
    expect(arr(vec3())).toEqual([0, 0, 0]);
  });

  it("writes through out-params and returns out", () => {
    const out = vec3();
    const a = vec3(1, 2, 3);
    const b = vec3(4, -5, 6);
    expect(vec3Set(out, 7, 8, 9)).toBe(out);
    expect(arr(out)).toEqual([7, 8, 9]);
    expect(arr(vec3Copy(out, a))).toEqual([1, 2, 3]);
    expect(arr(vec3Add(out, a, b))).toEqual([5, -3, 9]);
    expect(arr(vec3Sub(out, a, b))).toEqual([-3, 7, -3]);
    expect(arr(vec3Scale(out, a, 2))).toEqual([2, 4, 6]);
    expect(arr(vec3Madd(out, a, b, 0.5))).toEqual([3, -0.5, 6]);
    expect(arr(a)).toEqual([1, 2, 3]);
  });

  it("allows out to alias an input", () => {
    const a = vec3(1, 2, 3);
    vec3Add(a, a, a);
    expect(arr(a)).toEqual([2, 4, 6]);
    vec3Madd(a, a, a, -1);
    expect(arr(a)).toEqual([0, 0, 0]);
  });

  it("computes dot and cross products", () => {
    const x = vec3(1, 0, 0);
    const y = vec3(0, 1, 0);
    expect(vec3Dot(vec3(1, 2, 3), vec3(4, -5, 6))).toBe(12);
    expect(arr(vec3Cross(vec3(), x, y))).toEqual([0, 0, 1]);
    expect(arr(vec3Cross(vec3(), vec3(1, 2, 3), vec3(4, 5, 6)))).toEqual([-3, 6, -3]);
  });

  it("cross is safe when out aliases either input", () => {
    const a = vec3(1, 2, 3);
    const b = vec3(4, 5, 6);
    vec3Cross(a, a, b);
    expect(arr(a)).toEqual([-3, 6, -3]);
    const c = vec3(1, 2, 3);
    vec3Cross(b, c, b);
    expect(arr(b)).toEqual([-3, 6, -3]);
  });

  it("measures length and distance", () => {
    expect(vec3LengthSq(vec3(2, 3, 6))).toBe(49);
    expect(vec3Length(vec3(2, 3, 6))).toBe(7);
    expect(vec3Length(vec3(6, 2, 3))).toBe(7);
    expect(vec3DistanceSq(vec3(1, 1, 1), vec3(2, 3, 4))).toBe(14);
  });

  it("normalizes and returns the old length; zero stays zero", () => {
    const out = vec3();
    expect(vec3Normalize(out, vec3(0, 3, 4))).toBe(5);
    expect(arr(out)).toEqual([0, 0.6, 0.8]);
    const a = vec3(0, 0, -2);
    expect(vec3Normalize(a, a)).toBe(2);
    expect(arr(a)).toEqual([0, 0, -1]);
    expect(vec3Normalize(out, vec3())).toBe(0);
    expect(arr(out)).toEqual([0, 0, 0]);
  });

  it("compares exactly and checks finiteness", () => {
    expect(vec3ExactEquals(vec3(1, 2, 3), vec3(1, 2, 3))).toBe(true);
    expect(vec3ExactEquals(vec3(1, 2, 3), vec3(1, 2, 3 + 1e-12))).toBe(false);
    expect(vec3ExactEquals(vec3(0, 0, 0), vec3(-0, 0, 0))).toBe(true);
    expect(vec3ExactEquals(vec3(Number.NaN, 0, 0), vec3(Number.NaN, 0, 0))).toBe(false);
    expect(vec3IsFinite(vec3(1, -2, 3))).toBe(true);
    expect(vec3IsFinite(vec3(1, Number.POSITIVE_INFINITY, 3))).toBe(false);
    expect(vec3IsFinite(vec3(1, 2, Number.NaN))).toBe(false);
    expect(vec3IsFinite(vec3(Number.NaN, 0, 0))).toBe(false);
    expect(vec3IsFinite(vec3(Number.NEGATIVE_INFINITY, 0, 0))).toBe(false);
  });
});
