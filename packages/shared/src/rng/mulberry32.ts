import { DEV_ASSERT } from "../debug/assert";

/**
 * Mulberry32 (public-domain algorithm): a 32-bit-state PRNG built from Math.imul and shifts, so
 * every engine produces the same sequence. Seed it from hash32(matchSeed, entityId, tick, index)
 * (.claude/rules/shared-simulation.md), never from wall-clock time.
 */
export class Mulberry32 {
  /** Held in a typed array so the u32 state never becomes a heap number. */
  private readonly s = new Uint32Array(1);

  constructor(seed = 0) {
    this.s[0] = seed;
  }

  get state(): number {
    return this.s[0] as number;
  }

  reseed(seed: number): void {
    this.s[0] = seed;
  }

  nextU32(): number {
    const state = ((this.s[0] as number) + 0x6d2b79f5) >>> 0;
    this.s[0] = state;
    let z = Math.imul(state ^ (state >>> 15), state | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return (z ^ (z >>> 14)) >>> 0;
  }

  /** Uniform in [0, 1) with 32 random bits; the division by 2^32 is exact. */
  nextFloat(): number {
    return this.nextU32() / 4294967296;
  }

  /**
   * Uniform integer in [0, n) for an integer n in 1..2^21. Within that range u32 · n fits in 53
   * bits, so the product is exact and the result can never reach n.
   */
  nextInt(n: number): number {
    DEV_ASSERT(Number.isInteger(n) && n >= 1 && n <= 0x200000, "nextInt range must be 1..2^21", n);
    return Math.floor((this.nextU32() * n) / 4294967296);
  }
}
