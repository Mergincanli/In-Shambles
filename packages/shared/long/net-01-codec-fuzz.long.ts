import { describe, it } from "vitest";
import {
  expectBitFlipsSafe,
  expectCorruptionsSafe,
  expectTruncationsRefused,
  FULL_FUZZ,
} from "../test/helpers/codecFuzz";
import { MESSAGE_KINDS } from "../test/helpers/netMessages";

// NET-01 (docs/05 §3.6, §14), its long tier (D-032): the decoder fuzz of
// `packages/shared/test/net/codecs.test.ts` over its whole seeded streams (FULL_FUZZ: 40 messages
// of each type truncated, 12 of each type bit-flipped, 2000 snapshots and 2000 inputs corrupted),
// where `pnpm test` runs smaller counts (FAST_FUZZ) under the fast describe's names. Same seeds
// and checks (`codecFuzz.ts`, which says which fast sets are prefixes of these).

const kinds = MESSAGE_KINDS.map((k) => [k.name, k] as const);

describe("NET-01: codec fuzz over the whole seeded streams (docs/05 §3.6, §14)", () => {
  it.each(kinds)("%s: every truncation, an extra byte and dirty padding are refused", (_, k) =>
    expectTruncationsRefused(k, FULL_FUZZ.truncations),
  );

  it.each(kinds)("%s: every single-bit flip of valid messages", (_, k) =>
    expectBitFlipsSafe(k, FULL_FUZZ.bitFlips),
  );

  it("random multi-byte corruption of snapshots and inputs", () =>
    expectCorruptionsSafe(FULL_FUZZ.corruptions));
});
