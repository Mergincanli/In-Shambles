import { describe, expect, it } from "vitest";
import { murmur3Bytes } from "../../src/rng/hash32";
import {
  CMAP_HASH_OFFSET,
  CMAP_HASH_SEED_HI,
  CMAP_HASH_SEED_LO,
  cmapContentHash,
  cmapHashHex,
} from "../../src/world/cmapHash";

function bytesOf(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff);
}

describe("cmapContentHash", () => {
  it("is two Murmur3 lanes with different seeds over the file with bytes 16–23 zeroed", () => {
    const bytes = bytesOf(77);
    const zeroed = bytes.slice();
    zeroed.fill(0, CMAP_HASH_OFFSET, CMAP_HASH_OFFSET + 8);
    expect(CMAP_HASH_SEED_LO).not.toBe(CMAP_HASH_SEED_HI);
    expect(cmapContentHash(bytes)).toEqual({
      lo: murmur3Bytes(zeroed, CMAP_HASH_SEED_LO),
      hi: murmur3Bytes(zeroed, CMAP_HASH_SEED_HI),
    });
  });

  it("keeps the documented seeds and output (docs/07 §2)", () => {
    expect(CMAP_HASH_SEED_LO).toBe(0x636d6170);
    expect(CMAP_HASH_SEED_HI).toBe(0x9e3779b9);
    // Regression vectors: a change here changes every map's contentHash.
    expect(cmapHashHex(cmapContentHash(bytesOf(77)))).toBe("c21c510e2c5e0c11");
    expect(cmapHashHex(cmapContentHash(new Uint8Array(0)))).toBe("92ca2f0e97df4c9a");
  });

  it("does not modify its input", () => {
    const bytes = bytesOf(40);
    cmapContentHash(bytes);
    expect(bytes).toEqual(bytesOf(40));
  });

  it("ignores the hash field and sees every other byte", () => {
    const bytes = bytesOf(64);
    const h = cmapContentHash(bytes);
    for (let i = 0; i < bytes.length; i++) {
      const changed = bytes.slice();
      changed[i] = (changed[i] as number) ^ 0x40;
      const g = cmapContentHash(changed);
      const inField = i >= CMAP_HASH_OFFSET && i < CMAP_HASH_OFFSET + 8;
      expect(g.lo === h.lo, `byte ${i}`).toBe(inField);
      expect(g.hi === h.hi, `byte ${i}`).toBe(inField);
    }
  });

  it("covers the length, and handles files shorter than the hash field", () => {
    expect(cmapContentHash(bytesOf(64))).not.toEqual(cmapContentHash(bytesOf(72)));
    const short = bytesOf(20);
    expect(cmapContentHash(short)).toEqual(cmapContentHash(short.slice().fill(0, 16)));
  });
});

describe("cmapHashHex", () => {
  it("writes 16 lowercase hex digits, high lane first", () => {
    expect(cmapHashHex({ lo: 0xabc, hi: 0x1 })).toBe("0000000100000abc");
    expect(cmapHashHex({ lo: 0xffffffff, hi: 0xdeadbeef })).toBe("deadbeefffffffff");
  });
});
