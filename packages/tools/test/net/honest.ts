import { type ClientSim, STAT_STRIKES } from "@game/client/net";
import type { Match } from "@game/server";
import { expect } from "vitest";

/**
 * D-041's promise to honest clients: no session of `match` was struck, rate limited or kicked, and
 * no client of `clients` struck a server packet. Every NET run of honest clients ends with it, so
 * the rate limits (`sv_inputBurst` 240, refill 2 a tick) are proven against every frame model,
 * stall and resync those runs have.
 */
export function expectNoStrikes(match: Match, clients: readonly ClientSim[]): void {
  const m = match.metrics;
  expect(m.strikes, "server strike points (D-041)").toBe(0);
  expect(m.rateLimited, "packets dropped by the rate limits (D-041)").toBe(0);
  expect(m.kicks, "kicks (D-041)").toBe(0);
  for (const c of clients) expect(c.stats.totals[STAT_STRIKES], "client strikes").toBe(0);
}
