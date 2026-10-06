/**
 * MurmurHash3 x86_32 (public-domain algorithm), written from its published description. It is
 * for seeding and content identity, not security. Both entry points share the block and
 * finalization steps, so hash32(seed, a, b, c, d) === murmur3Bytes(<a, b, c, d as LE u32s>, seed).
 */

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

function mixK(k: number): number {
  let m = Math.imul(k, C1);
  m = (m << 15) | (m >>> 17);
  return Math.imul(m, C2);
}

function mixH(h: number, k: number): number {
  let m = h ^ mixK(k);
  m = (m << 13) | (m >>> 19);
  return (Math.imul(m, 5) + 0xe6546b64) | 0;
}

function finalize(h: number, byteLength: number): number {
  let f = h ^ byteLength;
  f ^= f >>> 16;
  f = Math.imul(f, 0x85ebca6b);
  f ^= f >>> 13;
  f = Math.imul(f, 0xc2b2ae35);
  f ^= f >>> 16;
  return f >>> 0;
}

/** Hash of a byte string; 32-bit blocks are read little-endian, byte by byte (no DataView). */
export function murmur3Bytes(bytes: Uint8Array, seed: number): number {
  const length = bytes.length;
  const blockEnd = length & ~3;
  let h = seed | 0;
  for (let i = 0; i < blockEnd; i += 4) {
    const k =
      (bytes[i] as number) |
      ((bytes[i + 1] as number) << 8) |
      ((bytes[i + 2] as number) << 16) |
      ((bytes[i + 3] as number) << 24);
    h = mixH(h, k);
  }
  const tail = length & 3;
  if (tail !== 0) {
    let k = bytes[blockEnd] as number;
    if (tail > 1) k |= (bytes[blockEnd + 1] as number) << 8;
    if (tail > 2) k |= (bytes[blockEnd + 2] as number) << 16;
    h ^= mixK(k);
  }
  return finalize(h, length);
}

/**
 * Hash of four u32 words (16 bytes), for seeding: hash32(matchSeed, entityId, tick, index).
 * An omitted `d` is 0, so the input length never changes.
 */
export function hash32(seed: number, a: number, b: number, c: number, d = 0): number {
  let h = seed | 0;
  h = mixH(h, a);
  h = mixH(h, b);
  h = mixH(h, c);
  h = mixH(h, d);
  return finalize(h, 16);
}
