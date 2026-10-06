import { describe, expect, it } from "vitest";
import {
  BitReader,
  BitWriter,
  readAscii,
  readText,
  writeAscii,
  writeText,
} from "../../src/net/bitstream";
import { Mulberry32 } from "../../src/rng/mulberry32";

/** 2^w − 1 for w in 1..32. */
function maxUnsigned(w: number): number {
  return 0xffffffff >>> (32 - w);
}

function reader(w: BitWriter): BitReader {
  const r = new BitReader();
  r.reset(w.bytes, w.byteLength);
  return r;
}

describe("BitWriter / BitReader", () => {
  it("packs LSB-first: the first value takes the low bits of byte 0", () => {
    const w = new BitWriter(8);
    w.writeBits(1, 1);
    w.writeBits(0b10, 2);
    w.writeBits(0x1f, 5);
    w.writeBits(0x1234, 16);
    expect(Array.from(w.bytes.subarray(0, w.byteLength))).toEqual([0b11111101, 0x34, 0x12]);
    expect(w.bitLength).toBe(24);
  });

  it("round-trips every width 1–32 at every bit offset", () => {
    const rng = new Mulberry32(0xb175);
    for (let offset = 0; offset < 8; offset++) {
      for (let width = 1; width <= 32; width++) {
        const max = maxUnsigned(width);
        const values = [0, 1, max, max >>> 1, rng.nextU32() >>> (32 - width)];
        const w = new BitWriter(64);
        w.writeBits(0, offset === 0 ? 1 : offset);
        for (const v of values) w.writeBits(v, width);
        expect(w.error).toBe(false);
        expect(w.bitLength).toBe((offset === 0 ? 1 : offset) + values.length * width);
        const r = reader(w);
        r.readBits(offset === 0 ? 1 : offset);
        for (const v of values) expect(r.readBits(width)).toBe(v);
        expect(r.error).toBe(false);
        expect(r.atEnd()).toBe(true);
      }
    }
  });

  it("round-trips a seeded random mix of widths, signed values and bools", () => {
    const rng = new Mulberry32(0x5eed);
    const ops: [kind: number, width: number, value: number][] = [];
    const w = new BitWriter(4096);
    for (let i = 0; i < 2000; i++) {
      const kind = rng.nextInt(3);
      const width = 1 + rng.nextInt(32);
      const raw = rng.nextU32();
      let value: number;
      if (kind === 0) {
        value = width === 32 ? raw : raw >>> (32 - width);
        w.writeBits(value, width);
      } else if (kind === 1) {
        value = width === 32 ? raw | 0 : ((raw << (32 - width)) | 0) >> (32 - width);
        w.writeSigned(value, width);
      } else {
        value = raw & 1;
        w.writeBool(value === 1);
      }
      ops.push([kind, width, value]);
    }
    expect(w.error).toBe(false);
    const r = reader(w);
    for (const [kind, width, value] of ops) {
      if (kind === 0) expect(r.readBits(width)).toBe(value);
      else if (kind === 1) expect(r.readSigned(width)).toBe(value);
      else expect(r.readBool()).toBe(value === 1);
    }
    expect(r.atEnd()).toBe(true);
  });

  it("carries the signed edges of every width in two's complement", () => {
    for (let width = 1; width <= 32; width++) {
      const lo = width === 32 ? -2147483648 : -((1 << (width - 1)) >>> 0);
      const hi = width === 32 ? 2147483647 : ((1 << (width - 1)) >>> 0) - 1;
      const values = [lo, hi, -1, 0];
      const w = new BitWriter(32);
      for (const v of values) w.writeSigned(v, width);
      expect(w.error, `width ${width}`).toBe(false);
      const r = reader(w);
      for (const v of values)
        expect(Object.is(r.readSigned(width), v), `${width}: ${v}`).toBe(true);
      // −1 is all ones.
      const ones = new BitWriter(8);
      ones.writeSigned(-1, width);
      expect(reader(ones).readBits(width)).toBe(maxUnsigned(width));
      // One past either end does not fit.
      for (const bad of [lo - 1, hi + 1]) {
        const x = new BitWriter(8);
        x.writeSigned(bad, width);
        expect(x.error, `${width}: ${bad}`).toBe(true);
      }
    }
  });

  it("flags values a width can't carry, bad widths and non-integers, and stays flagged", () => {
    const cases: [number, number][] = [
      [2, 1],
      [256, 8],
      [-1, 8],
      [0.5, 8],
      [Number.NaN, 8],
      [Number.POSITIVE_INFINITY, 32],
      [4294967296, 32],
      [0, 0],
      [0, 33],
      [0, 1.5],
    ];
    for (const [value, width] of cases) {
      const w = new BitWriter(8);
      w.writeBits(value, width);
      expect(w.error, `${value} in ${width}`).toBe(true);
      expect(w.bitLength).toBe(0);
      w.writeBits(1, 1);
      expect(w.bitLength).toBe(0);
    }
    const s = new BitWriter(8);
    s.writeSigned(1.5, 8);
    expect(s.error).toBe(true);
    s.reset();
    expect(s.error).toBe(false);
    s.writeBits(1, 1);
    expect(s.bitLength).toBe(1);
  });

  it("flags an overflow instead of writing past the buffer", () => {
    const w = new BitWriter(2);
    w.writeBits(0xffff, 16);
    expect(w.error).toBe(false);
    w.writeBits(1, 1);
    expect(w.error).toBe(true);
    expect(w.bitLength).toBe(16);
    expect(w.byteLength).toBe(2);
    const f = new BitWriter(7);
    f.writeF64(1);
    expect(f.error).toBe(true);
  });

  it("flags a short read, returns 0 and stays flagged", () => {
    const w = new BitWriter(2);
    w.writeBits(0xabc, 12);
    const r = reader(w);
    expect(r.bitsLeft).toBe(16);
    expect(r.readBits(12)).toBe(0xabc);
    expect(r.readBits(5)).toBe(0);
    expect(r.error).toBe(true);
    expect(r.readBits(1)).toBe(0);
    expect(r.readSigned(2)).toBe(0);
    expect(r.atEnd()).toBe(false);
    const bad = new BitReader();
    bad.reset(w.bytes, 2);
    expect(bad.readBits(0)).toBe(0);
    expect(bad.error).toBe(true);
  });

  it("clamps the readable length to the array", () => {
    const r = new BitReader();
    r.reset(new Uint8Array([1, 2]), 10);
    expect(r.bitsLeft).toBe(16);
    r.reset(new Uint8Array([1, 2]), -3);
    expect(r.bitsLeft).toBe(0);
    expect(r.atEnd()).toBe(true);
  });

  it("atEnd accepts zero padding only, and no extra bytes", () => {
    const w = new BitWriter(4);
    w.writeBits(0b101, 3);
    expect(w.byteLength).toBe(1);
    const r = reader(w);
    r.readBits(3);
    expect(r.atEnd()).toBe(true);
    const dirty = new BitReader();
    dirty.reset(new Uint8Array([0b1000_0101]), 1);
    dirty.readBits(3);
    expect(dirty.atEnd()).toBe(false);
    const extra = new BitReader();
    extra.reset(new Uint8Array([0b101, 0]), 2);
    extra.readBits(3);
    expect(extra.atEnd()).toBe(false);
  });

  it("reset clears what an earlier message left in the buffer", () => {
    const w = new BitWriter(4);
    w.writeBits(0xffffffff, 32);
    w.reset();
    w.writeBits(1, 3);
    w.writeBits(0, 7);
    expect(Array.from(w.bytes.subarray(0, w.byteLength))).toEqual([1, 0]);
    w.padToByte();
    expect(w.bitLength).toBe(16);
    w.padToByte();
    expect(w.bitLength).toBe(16);
  });

  it("carries the raw bits of every double, low word first", () => {
    const values = [
      0,
      -0,
      1,
      -1.5,
      0.1 + 0.2,
      Number.MIN_VALUE,
      -Number.MAX_VALUE,
      2.2250738585072014e-308,
      Number.POSITIVE_INFINITY,
      Number.NaN,
    ];
    const w = new BitWriter(128);
    w.writeBits(1, 3);
    for (const v of values) w.writeF64(v);
    const r = reader(w);
    r.readBits(3);
    for (const v of values) expect(Object.is(r.readF64(), v), String(v)).toBe(true);
    const one = new BitWriter(8);
    one.writeF64(1);
    // 1.0 = 0x3ff0000000000000: the low word is 0, the high word holds the exponent.
    expect(Array.from(one.bytes)).toEqual([0, 0, 0, 0, 0, 0, 0xf0, 0x3f]);
  });
});

describe("ASCII and text fields", () => {
  it("round-trip printable ASCII in 7 bits and Latin-1 text in 8", () => {
    const w = new BitWriter(256);
    writeAscii(w, "abc XYZ ~!", 6, 63);
    writeText(w, "say hello\twörld\n", 10, 1023);
    writeAscii(w, "", 6, 63);
    expect(w.error).toBe(false);
    expect(w.bitLength).toBe(6 + 10 * 7 + 10 + 16 * 8 + 6);
    const r = reader(w);
    expect(readAscii(r, 6, 63)).toBe("abc XYZ ~!");
    expect(readText(r, 10, 1023)).toBe("say hello\twörld\n");
    expect(readAscii(r, 6, 63)).toBe("");
    expect(r.atEnd()).toBe(true);
  });

  it("refuse strings that are too long or hold chars outside their set", () => {
    for (const [text, ascii] of [
      ["x".repeat(64), true],
      ["tab\t", true],
      ["é", true],
      ["\u0000", false],
      ["\u007f", false],
      ["€", false],
      ["x".repeat(1024), false],
    ] as const) {
      const w = new BitWriter(2048);
      if (ascii) writeAscii(w, text, 6, 63);
      else writeText(w, text, 10, 1023);
      expect(w.error, JSON.stringify(text)).toBe(true);
    }
  });

  it("decode to null on a short read, a long length or a bad char", () => {
    const short = new BitWriter(8);
    short.writeBits(5, 6);
    short.writeBits(0x41, 7);
    expect(readAscii(reader(short), 6, 63)).toBeNull();
    const long = new BitWriter(8);
    long.writeBits(40, 6);
    expect(readAscii(reader(long), 6, 30)).toBeNull();
    const ctl = new BitWriter(8);
    ctl.writeBits(1, 10);
    ctl.writeBits(0x07, 8);
    expect(readText(reader(ctl), 10, 1023)).toBeNull();
    const del = new BitWriter(8);
    del.writeBits(1, 6);
    del.writeBits(0x7f, 7);
    expect(readAscii(reader(del), 6, 63)).toBeNull();
  });
});
