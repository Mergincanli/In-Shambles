import { murmur3Bytes } from "../rng/hash32";

/**
 * The cmap contentHash (docs/07 §2): 64 bits from two Murmur3 x86_32 lanes with different seeds,
 * over the whole file with the hash field itself (bytes 16–23 of the preamble) read as zero, so
 * every other byte is covered and the hash never covers itself. It identifies a compiled map for
 * caching and for checking that client and server loaded the same file; it is not a security
 * measure, since anyone can recompute it after editing a file.
 */

/** Byte offset of hashLo in the preamble; hashHi follows at +4. */
export const CMAP_HASH_OFFSET = 16;
export const CMAP_HASH_BYTES = 8;

/** Seed of the low lane: the ASCII bytes "cmap" read as a big-endian u32. */
export const CMAP_HASH_SEED_LO = 0x636d6170;
/** Seed of the high lane: the 32-bit golden ratio constant, unrelated to the low seed. */
export const CMAP_HASH_SEED_HI = 0x9e3779b9;

export interface CmapHash {
  readonly lo: number;
  readonly hi: number;
}

/**
 * Hashes `bytes` as a cmap file without modifying it. Load time only: it copies the file once,
 * through the constructor, because a subclass's slice() may return a view (Node's Buffer does).
 */
export function cmapContentHash(bytes: Uint8Array): CmapHash {
  const zeroed = new Uint8Array(bytes);
  const end = Math.min(zeroed.length, CMAP_HASH_OFFSET + CMAP_HASH_BYTES);
  for (let i = CMAP_HASH_OFFSET; i < end; i++) zeroed[i] = 0;
  return {
    lo: murmur3Bytes(zeroed, CMAP_HASH_SEED_LO),
    hi: murmur3Bytes(zeroed, CMAP_HASH_SEED_HI),
  };
}

/** 16 lowercase hex digits, high lane first. */
export function cmapHashHex(hash: CmapHash): string {
  return hash.hi.toString(16).padStart(8, "0") + hash.lo.toString(16).padStart(8, "0");
}
