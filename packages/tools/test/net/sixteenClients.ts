import { findNetProfile, MAX_SNAPSHOT_BYTES, MSG_SNAPSHOT, type NetProfile } from "@game/shared";
import { expect } from "vitest";
import { createBotInput, runsRoute } from "../../src/bots/routes";
import { DeltaWatch, ticksIn } from "./deltaWatch";
import {
  FRAMES_144HZ,
  FRAMES_BROWSER_HITCHES,
  type HarnessClient,
  MultiHarness,
} from "./multiHarness";

// NET-04's 16-client legs (docs/05 §14; M3 design §5, §6 increment 9), in its long file
// (`packages/tools/long/net-04-reconciliation.long.ts`, D-032): 16 clients on arena_greybox
// through the real match over delta snapshots (D-038), each on its own NetSim seed, joining 100 ms
// apart, running the bots' behaviours (3 in 5 strafe-jump the yard ring, the rest random-walk;
// client 0, observed with every tick recorded, runs the ring at 144 Hz; the others alternate
// 144 Hz and browser hitches). Prediction must hold: every client under 1 correction/s with a
// mean under 2 u; the observed one reconciles every snapshot, its drawn position never offset by
// 8 u or more, and its stored frames equal the server's. No strike; every snapshot ≤ 1100 B and a
// delta whenever the client's ack allows (`DeltaWatch`). Each leg prints per-client bandwidth,
// the delta share and the match tick, to compare with the M3 baseline of full snapshots
// (increment 4–8: 436 B each, 26.4 KB/s down per client with framing).

export const SIXTEEN = 16;

export interface SixteenRun {
  readonly h: MultiHarness;
  readonly watch: DeltaWatch;
  readonly link: NetProfile;
  readonly seconds: number;
  /** Per client: top horizontal speed (u/s) and the larger of its x and y extents (u). */
  readonly top: Float64Array;
  readonly extent: Float64Array;
  /** Per client: wire bytes down and up over the measured part. */
  readonly down: number[];
  readonly up: number[];
}

export function runSixteen(profileName: string, seed: number, seconds: number): SixteenRun {
  const h = new MultiHarness({ map: "arena_greybox", seed, timeTicks: true });
  const link = findNetProfile(profileName) as NetProfile;
  const watch = new DeltaWatch(h, ticksIn(2 * (link.delayMs + link.jitterMs) + 100));
  for (let i = 0; i < SIXTEEN; i++) {
    h.addClient({
      input: createBotInput("arena_greybox", i, seed),
      profile: link,
      frameIntervalMs: i % 2 === 0 ? FRAMES_144HZ : FRAMES_BROWSER_HITCHES,
      record: i === 0,
    });
    h.run(100);
  }
  // What the server simulated: each player's top horizontal speed and the x/y extent covered.
  const top = new Float64Array(SIXTEEN);
  const box = new Float64Array(SIXTEEN * 4).fill(Number.NaN);
  const watchTick = h.afterServerTick;
  h.afterServerTick = () => {
    watchTick?.();
    for (let i = 0; i < SIXTEEN; i++) {
      const p = (h.clients[i] as HarnessClient).session?.player;
      if (p === undefined) continue;
      const x = p.origin[0] as number;
      const y = p.origin[1] as number;
      top[i] = Math.max(
        top[i] as number,
        Math.hypot(p.velocity[0] as number, p.velocity[1] as number),
      );
      const b = i * 4;
      box[b] = Number.isNaN(box[b] as number) ? x : Math.min(box[b] as number, x);
      box[b + 1] = Number.isNaN(box[b + 1] as number) ? x : Math.max(box[b + 1] as number, x);
      box[b + 2] = Number.isNaN(box[b + 2] as number) ? y : Math.min(box[b + 2] as number, y);
      box[b + 3] = Number.isNaN(box[b + 3] as number) ? y : Math.max(box[b + 3] as number, y);
    }
  };
  const t0 = h.now;
  const down0 = h.clients.map((c) => c.tap.down.wireBytes);
  const up0 = h.clients.map((c) => c.tap.up.wireBytes);
  h.run(seconds * 1000);
  h.afterServerTick = watchTick;
  const extent = new Float64Array(SIXTEEN);
  for (let i = 0; i < SIXTEEN; i++) {
    const b = i * 4;
    extent[i] = Math.max(
      (box[b + 1] as number) - (box[b] as number),
      (box[b + 3] as number) - (box[b + 2] as number),
    );
  }
  return {
    h,
    watch,
    link,
    seconds: (h.now - t0) / 1000,
    top,
    extent,
    down: h.clients.map((c, i) => c.tap.down.wireBytes - (down0[i] as number)),
    up: h.clients.map((c, i) => c.tap.up.wireBytes - (up0[i] as number)),
  };
}

/** The 16-client leg's pass conditions; returns its account for the log. */
export function expectSixteen(run: SixteenRun): string {
  const { h, watch, link, seconds, top, extent, down, up } = run;
  const observed = h.clients[0] as HarnessClient;
  expect(observed.unreconciled()).toEqual([]);
  expect(observed.snapshotTicks.length).toBeGreaterThan(seconds * 60 * 0.5);
  expect(Math.max(...observed.frames.offset)).toBeLessThan(8);
  expect(observed.digestsChecked).toBeGreaterThan(seconds * 60 * 0.5);
  expect(observed.digestMismatches).toEqual([]);

  let worstRate = 0;
  let worstMean = 0;
  for (let i = 0; i < SIXTEEN; i++) {
    const c = h.clients[i] as HarnessClient;
    const t = c.totals();
    expect(c.client.active, `client ${i}`).toBe(true);
    expect(c.session?.stats.strikes, `client ${i}`).toBe(0);
    expect(c.client.store.baselineDrops, `client ${i}`).toBe(0);
    expect(t.hardResyncs, `client ${i}`).toBeLessThanOrEqual(2);
    expect(t.teleports, `client ${i}`).toBe(0);
    // The link really was the profile's: packets lost, its RTT plus jitter and ticks.
    expect(c.sim?.stats().lost, `client ${i}`).toBeGreaterThan(0);
    expect(c.client.clock.rttMs, `client ${i}`).toBeGreaterThanOrEqual(2 * link.delayMs);
    expect(c.client.clock.rttMs, `client ${i}`).toBeLessThan(2 * link.delayMs + 120);
    // And the player moved: at running speed or faster, over hundreds of units.
    expect(top[i], `client ${i}`).toBeGreaterThan(300);
    expect(extent[i], `client ${i}`).toBeGreaterThan(runsRoute(i) ? 500 : 150);
    expect(c.tap.down.maxByType[MSG_SNAPSHOT], `client ${i}`).toBeLessThanOrEqual(
      MAX_SNAPSHOT_BYTES,
    );
    worstRate = Math.max(worstRate, t.corrections / seconds);
    worstMean = Math.max(worstMean, t.meanCorrection);
  }
  // The last one in got the other 15 as new bodies: 86 + 199 + 7 + 15 × 213 bits.
  expect((h.clients[SIXTEEN - 1] as HarnessClient).tap.maxFullSnapshot).toBe(436);
  const ticks = h.tickTimes;
  const account =
    `NET-04, ${SIXTEEN} clients, arena_greybox, ${link.name}, ${seconds.toFixed(0)} s: corrections ` +
    `worst ${worstRate.toFixed(2)}/s (mean ≤ ${worstMean.toFixed(2)} u); per client down ≤ ` +
    `${(Math.max(...down) / seconds / 1000).toFixed(2)} KB/s, up ≤ ` +
    `${(Math.max(...up) / seconds / 1000).toFixed(2)} KB/s (payload + WebSocket framing, KB = ` +
    `1000 B; full snapshots took 26.4 KB/s); ${watch.describe()}; match tick ` +
    `p50 ${ticks?.percentileUs(50)} µs, p99 ${ticks?.percentileUs(99)} µs, max ${ticks?.maxUs} µs ` +
    "(in-process, Vitest)";
  expect(worstRate, account).toBeLessThan(1);
  expect(worstMean, account).toBeLessThan(2);
  expect(watch.failures, account).toEqual([]);
  expect(watch.fullsWithBaseline).toBe(0);
  expect(watch.acksAhead).toBe(0);
  expect(watch.warmDeltaShare, account).toBeGreaterThanOrEqual(0.9);
  expect(h.match.metrics.strikes).toBe(0);
  return account;
}
