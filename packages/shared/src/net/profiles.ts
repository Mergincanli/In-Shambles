/**
 * Network simulator profiles (docs/10 §3 is the canonical table, mirrored in docs/05 §13; D-028).
 * Tests, bots and the in-game `net_profile` command all use these. They are test conditions, not
 * game tunables: a doc-golden test (packages/tools/test/docs/net-profiles-docs.test.ts) keeps
 * them equal to both tables.
 */
export interface NetProfile {
  readonly name: string;
  /** One-way delay in ms, applied to each direction. */
  readonly delayMs: number;
  /** Each packet's delay varies uniformly within ±jitterMs. */
  readonly jitterMs: number;
  /** Probabilities per unreliable packet, 0..1. Reliable packets are never lost or duplicated. */
  readonly loss: number;
  readonly duplicate: number;
  readonly reorder: number;
}

function profile(
  name: string,
  delayMs: number,
  jitterMs: number,
  loss: number,
  duplicate: number,
  reorder: number,
): NetProfile {
  return Object.freeze({ name, delayMs, jitterMs, loss, duplicate, reorder });
}

export const NET_PROFILE_LAN: NetProfile = profile("lan", 0, 0, 0, 0, 0);

export const NET_PROFILES: readonly NetProfile[] = Object.freeze([
  NET_PROFILE_LAN,
  profile("wan-50", 25, 3, 0, 0, 0),
  profile("wan-100-loss1", 50, 8, 0.01, 0, 0),
  profile("wan-150-loss2", 75, 15, 0.02, 0, 0.005),
  profile("bad-250-loss5", 125, 40, 0.05, 0.01, 0.01),
]);

/** The profile called `name`, or undefined (the console lists `NET_PROFILES` then). */
export function findNetProfile(name: string): NetProfile | undefined {
  for (const p of NET_PROFILES) if (p.name === name) return p;
  return undefined;
}
