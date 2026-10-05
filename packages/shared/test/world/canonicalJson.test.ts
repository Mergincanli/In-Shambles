import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/world/canonicalJson";

describe("canonicalJson", () => {
  it("sorts keys by code unit, where JSON.stringify puts integer-like keys first", () => {
    const value = { b: 0, "10": 0, a: 0, "2": 0, B: 0 };
    expect(JSON.stringify(value)).toBe('{"2":0,"10":0,"b":0,"a":0,"B":0}');
    expect(canonicalJson(value)).toBe('{"10":0,"2":0,"B":0,"a":0,"b":0}');
  });

  it("gives the same text whatever the insertion order", () => {
    expect(canonicalJson({ x: [1, { q: 1, p: 2 }], a: "s" })).toBe(
      canonicalJson({ a: "s", x: [1, { p: 2, q: 1 }] }),
    );
  });

  it("writes numbers with String(n), -0 as 0", () => {
    expect(canonicalJson([0, -0, 1.5, -2, 1e21, 1e-7, 0.1])).toBe("[0,0,1.5,-2,1e+21,1e-7,0.1]");
    for (const n of [1e21, 1e-7, 0.1, -123.456, Number.MIN_VALUE]) {
      expect(JSON.parse(canonicalJson(n))).toBe(n);
    }
  });

  it("escapes everything above 0x7E, so the text is printable ASCII", () => {
    const s = 'café ☕ \u{1f600} \u007f \ud800 tab\t quote" back\\';
    const text = canonicalJson({ [s]: s });
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      expect(c >= 0x20 && c <= 0x7e, `char ${i}`).toBe(true);
    }
    expect(text).toContain("caf\\u00e9 \\u2615 \\ud83d\\ude00 \\u007f \\ud800");
    expect(JSON.parse(text)).toEqual({ [s]: s });
  });

  it("leaves out undefined members and writes null and booleans", () => {
    expect(canonicalJson({ a: undefined, b: null, c: true, d: false })).toBe(
      '{"b":null,"c":true,"d":false}',
    );
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", [Number.POSITIVE_INFINITY]],
    ["undefined in an array", [undefined]],
    ["a bigint", 1n],
    ["a typed array", new Float32Array(1)],
    ["a Map", new Map()],
  ])("refuses %s", (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});
