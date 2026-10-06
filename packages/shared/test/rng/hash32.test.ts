import { describe, expect, it } from "vitest";
import { hash32, murmur3Bytes } from "../../src/rng/hash32";
import { Mulberry32 } from "../../src/rng/mulberry32";

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** u32 words as little-endian bytes. */
function wordsLE(...words: number[]): Uint8Array {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < words.length; i++) view.setUint32(i * 4, (words[i] ?? 0) >>> 0, true);
  return bytes;
}

describe("murmur3Bytes (MurmurHash3 x86_32)", () => {
  // Published test vectors for MurmurHash3_x86_32.
  it.each([
    [[], 0, 0x00000000],
    [[], 1, 0x514e28b7],
    [[], 0xffffffff, 0x81f16f39],
    [[0xff, 0xff, 0xff, 0xff], 0, 0x76293b50],
    [[0x21, 0x43, 0x65, 0x87], 0, 0xf55b516b],
    [[0x21, 0x43, 0x65, 0x87], 0x5082edee, 0x2362f9de],
    [[0x21, 0x43, 0x65], 0, 0x7e4a8634],
    [[0x21, 0x43], 0, 0xa0f7b07a],
    [[0x21], 0, 0x72661cf4],
    [[0, 0, 0, 0], 0, 0x2362f9de],
    [[0, 0, 0], 0, 0x85f0b427],
    [[0, 0], 0, 0x30f4c306],
    [[0], 0, 0x514e28b7],
  ])("bytes %j, seed %i", (bytes, seed, expected) => {
    expect(murmur3Bytes(Uint8Array.from(bytes), seed)).toBe(expected);
  });

  it.each([
    ["Hello, world!", 0x9747b28c, 0x24884cba],
    ["The quick brown fox jumps over the lazy dog", 0x9747b28c, 0x2fa826cd],
  ])("ASCII %j, seed %i", (text, seed, expected) => {
    expect(murmur3Bytes(ascii(text), seed)).toBe(expected);
  });

  it("reads a subarray view at its own offset", () => {
    const buffer = ascii("xxHello, world!");
    expect(murmur3Bytes(buffer.subarray(2), 0x9747b28c)).toBe(0x24884cba);
  });
});

describe("hash32", () => {
  it("equals murmur3Bytes over the same four words, little-endian", () => {
    const rng = new Mulberry32(2024);
    for (let i = 0; i < 2000; i++) {
      const seed = rng.nextU32();
      const w = [rng.nextU32(), rng.nextU32(), rng.nextU32(), rng.nextU32()] as const;
      expect(hash32(seed, w[0], w[1], w[2], w[3])).toBe(murmur3Bytes(wordsLE(...w), seed));
    }
  });

  it("treats an omitted fourth word as 0 and accepts signed words", () => {
    expect(hash32(7, 1, 2, 3)).toBe(hash32(7, 1, 2, 3, 0));
    expect(hash32(-1, -1, -2, -3, -4)).toBe(
      hash32(0xffffffff, 0xffffffff, 0xfffffffe, 0xfffffffd, 0xfffffffc),
    );
  });

  it("returns u32 values that differ for each input word", () => {
    const base = hash32(1, 2, 3, 4, 5);
    expect(Number.isInteger(base) && base >= 0 && base <= 0xffffffff).toBe(true);
    expect(
      new Set([
        base,
        hash32(0, 2, 3, 4, 5),
        hash32(1, 0, 3, 4, 5),
        hash32(1, 2, 0, 4, 5),
        hash32(1, 2, 3, 0, 5),
        hash32(1, 2, 3, 4, 0),
      ]).size,
    ).toBe(6);
  });
});
