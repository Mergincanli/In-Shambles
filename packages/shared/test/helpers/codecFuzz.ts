import { expect } from "vitest";
import type { BitWriter } from "../../src/net/bitstream";
import { MSG_INPUT, MSG_SNAPSHOT } from "../../src/net/protocol";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { MESSAGE_KINDS, type MessageKind, newWriter, readerOver } from "./netMessages";

// NET-01's decoder fuzz (docs/05 §3.6, §14), shared by its two tiers (D-032): the fast tier
// (`test/net/codecs.test.ts`) runs each fuzz with the same seeds and smaller counts, the long
// tier (`long/net-01-codec-fuzz.long.ts`) with the full counts. The truncation and bit-flip
// streams have a generator per message type, so the fast messages are the long ones' first; the
// corruption fuzz draws snapshots, then inputs, from one generator, so its fast inputs start at
// another point of the stream than the long ones (the fast snapshots are still a prefix).

/** How many seeded messages each fuzz takes. */
export interface CodecFuzzCounts {
  /** Per message type: every truncation, an extra byte and dirty padding. */
  readonly truncations: number;
  /** Per message type: every single-bit flip (a seeded sample of bits on long messages). */
  readonly bitFlips: number;
  /** Snapshots, then inputs: random multi-byte corruption. */
  readonly corruptions: number;
}

/** The long tier's counts (the full NET-01 fuzz). */
export const FULL_FUZZ: CodecFuzzCounts = { truncations: 40, bitFlips: 12, corruptions: 2000 };
/** The fast tier's counts: the same seeds, smaller counts. */
export const FAST_FUZZ: CodecFuzzCounts = { truncations: 10, bitFlips: 3, corruptions: 500 };

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function kindOf(type: number): MessageKind {
  const k = MESSAGE_KINDS.find((m) => m.type === type);
  if (k === undefined) throw new Error(`no kind ${type}`);
  return k;
}

/**
 * Decodes `bytes` with every decoder; whichever accepts it must re-encode it, and byte for byte
 * (so an accepted packet is exactly what an encoder writes: every value in range and canonical).
 * A decoder that accepts what its encoder refuses fails the test. Returns how many decoders
 * accepted it.
 */
export function decodeEverywhere(bytes: Uint8Array, length: number, w: BitWriter): number {
  let accepted = 0;
  for (const k of MESSAGE_KINDS) {
    if (!k.decode(readerOver(bytes, length))) continue;
    accepted++;
    expect(k.type).toBe(bytes[0]);
    expect(
      k.decodeAndReencode(readerOver(bytes, length), w),
      `${k.name} accepted a packet its encoder refuses: ${hex(bytes.subarray(0, length))}`,
    ).toBe(true);
    expect(hex(w.bytes.subarray(0, w.byteLength))).toBe(hex(bytes.subarray(0, length)));
  }
  return accepted;
}

/** Every truncation of `messages` seeded `k` messages, one extra byte and dirty padding fail. */
export function expectTruncationsRefused(k: MessageKind, messages: number): void {
  const rng = new Mulberry32(0x7a11 + k.type);
  const w = newWriter();
  for (let i = 0; i < messages; i++) {
    const bytes = k.random(rng, w);
    for (let len = 0; len < bytes.length; len++) {
      expect(k.decode(readerOver(bytes, len)), `${len} of ${bytes.length}`).toBe(false);
    }
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    expect(k.decode(readerOver(longer))).toBe(false);
    // Set the first padding bit of the last byte, if the message has one.
    w.reset();
    expect(k.decode(readerOver(bytes))).toBe(true);
    k.decodeAndReencode(readerOver(bytes), w);
    const used = w.bitLength & 7;
    if (used !== 0) {
      const dirty = bytes.slice();
      dirty[dirty.length - 1] = (dirty[dirty.length - 1] as number) | (1 << used);
      expect(k.decode(readerOver(dirty))).toBe(false);
    }
  }
}

/** Every single-bit flip of `messages` seeded `k` messages decodes safely (decodeEverywhere). */
export function expectBitFlipsSafe(k: MessageKind, messages: number): void {
  const rng = new Mulberry32(0xf1f + k.type);
  const w = newWriter();
  for (let i = 0; i < messages; i++) {
    const bytes = k.random(rng, w);
    // Long text and cvar messages: a seeded sample of bits instead of all of them.
    const bits = bytes.length * 8;
    const step = bits > 768 ? Math.ceil(bits / 768) : 1;
    for (let bit = rng.nextInt(step); bit < bits; bit += step) {
      const flipped = bytes.slice();
      flipped[bit >> 3] = (flipped[bit >> 3] as number) ^ (1 << (bit & 7));
      decodeEverywhere(flipped, flipped.length, w);
    }
  }
}

/** `messages` seeded snapshots, then as many inputs, with 1–4 random bytes each, decode safely. */
export function expectCorruptionsSafe(messages: number): void {
  const rng = new Mulberry32(0xc0de);
  const w = newWriter();
  for (const type of [MSG_SNAPSHOT, MSG_INPUT]) {
    const k = kindOf(type);
    for (let i = 0; i < messages; i++) {
      const bytes = k.random(rng, w);
      const n = 1 + rng.nextInt(4);
      for (let j = 0; j < n; j++) bytes[rng.nextInt(bytes.length)] = rng.nextInt(256);
      decodeEverywhere(bytes, bytes.length, w);
    }
  }
}
