import { PerformanceObserver } from "node:perf_hooks";
import { findNetProfile, type NetProfile } from "@game/shared";
import { describe, expect, it } from "vitest";
import { createBotInput } from "../../src/bots/routes";
import { FRAMES_144HZ, FRAMES_BROWSER_HITCHES, MultiHarness } from "./multiHarness";

// NET-09 (docs/05 §14; M3 design §5): server performance with 16 bots. This is the fast
// in-process proxy (M3 increment 6): the real match with 16 real clients on arena_greybox at
// wan-100-loss1, the bots' own behaviours (3 in 5 strafe-jump the yard ring, the rest random-walk;
// packages/tools/src/bots/routes.ts), every match tick timed on the real clock. Bounds: tick p50
// ≤ 1.5 ms, at most 1% of ticks over 4 ms (the docs/10 §4.1 p99, judged as a share because the
// Vitest workers share the host), no GC pause over 8 ms; one retry, as the design allows, for a
// window a busy host spoiled. The window is 30 s of the harness's fake clock (about 1–2 s of
// wall time), so 1% is 18 ticks, not a handful; the GC observer sees the whole worker (the 16
// clients too), which only makes the bound stricter. It prints the tick's cost and, after a
// retry, the first window's numbers. The real measurement (the built server,
// 16 bots over real sockets, 1 min after a 10 s discard) is the load tier's (increment 18);
// `pnpm bots` measures the same today (docs/10 §4.1).

const CLIENTS = 16;
/** Simulated seconds per window (fake clock). */
const WINDOW_S = 30;
const P50_US = 1500;
const SLOW_US = 4000;
const SLOW_SHARE = 0.01;
const GC_MS = 8;

describe("NET-09 proxy: 16 clients on arena_greybox, the match tick in process", () => {
  it("ticks at p50 ≤ 1.5 ms with ≤ 1% of ticks over 4 ms and no GC pause over 8 ms", async () => {
    const h = new MultiHarness({ map: "arena_greybox", seed: 9, timeTicks: true });
    const link = findNetProfile("wan-100-loss1") as NetProfile;
    for (let i = 0; i < CLIENTS; i++) {
      h.addClient({
        input: createBotInput("arena_greybox", i, 9),
        profile: link,
        frameIntervalMs: i % 2 === 0 ? FRAMES_144HZ : FRAMES_BROWSER_HITCHES,
      });
      h.run(100);
    }
    // Every bot in and moving before the window opens.
    h.run(3000);
    expect(h.active.length).toBe(CLIENTS);

    const ticks = h.tickTimes;
    if (ticks === null) throw new Error("tick timing is off");
    const gcPauses: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) gcPauses.push(e.duration);
    });
    observer.observe({ entryTypes: ["gc"] });
    const measure = async () => {
      ticks.reset();
      gcPauses.length = 0;
      h.run(WINDOW_S * 1000);
      // The observer's entries arrive from the event loop, after the synchronous run.
      await new Promise((resolve) => setTimeout(resolve, 20));
      let slow = 0;
      for (let b = SLOW_US / 10; b < ticks.counts.length; b++) slow += ticks.counts[b] as number;
      return {
        ticks: ticks.count,
        p50: ticks.percentileUs(50),
        p99: ticks.percentileUs(99),
        max: ticks.maxUs,
        slowShare: slow / ticks.count,
        gcMax: Math.max(0, ...gcPauses),
        gcs: gcPauses.length,
      };
    };
    const ok = (r: Awaited<ReturnType<typeof measure>>) =>
      r.p50 <= P50_US && r.slowShare <= SLOW_SHARE && r.gcMax <= GC_MS;
    let r = await measure();
    const first = r;
    if (!ok(r)) r = await measure();
    observer.disconnect();
    const detail = JSON.stringify({ first, final: r });
    console.log(
      `NET-09 proxy: ${CLIENTS} clients, arena_greybox, wan-100-loss1, ${WINDOW_S} simulated s: match tick ` +
        `p50 ${r.p50} µs, p99 ${r.p99} µs, max ${r.max} µs, ${(r.slowShare * 100).toFixed(2)}% over ` +
        `4 ms; ${r.gcs} GCs, longest ${r.gcMax.toFixed(2)} ms (in process, Vitest)` +
        (r === first ? "" : `; retried after ${JSON.stringify(first)}`),
    );
    expect(r.ticks, detail).toBeGreaterThan(WINDOW_S * 60 * 0.95);
    expect(r.p50, detail).toBeLessThanOrEqual(P50_US);
    expect(r.slowShare, detail).toBeLessThanOrEqual(SLOW_SHARE);
    expect(r.gcMax, detail).toBeLessThanOrEqual(GC_MS);
    expect(h.match.metrics.strikes).toBe(0);
    expect(h.active.length).toBe(CLIENTS);
  });
});
