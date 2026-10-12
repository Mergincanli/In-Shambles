import { describe, expect, it } from "vitest";
import { expectHealthy } from "../../client/e2e/health";
import type { BotsSummary } from "../src/bots/summary";
import { type BotsCliRun, check, runBotsCli, settleHost, summaryOf, writeNotes } from "./helpers";

// The M3 acceptance check "16 bots + 1 human on arena_greybox at wan-100-loss1: smooth remote
// motion, server tick p99 ≤ 4 ms" (docs/09 M3, M3 design §5 "16 + 1", D-045), with the headless
// Chromium stand-in (Mustafa's answer 3): `pnpm bots --count 16 --profile wan-100-loss1
// --minutes 2 --map arena_greybox --human --strict` against the built server (its default
// sv_maxClients 32 holds 17: no flag) and the production client build, the bots and the browser
// at nice 10. The human joined (the server holds 17, its page draws 16), its prediction stays
// healthy by the e2e rule (`packages/client/e2e/health.ts`) and inside NET-04's bounds, its
// remotes never jump (NET-05) at a 2–6 tick delay, the server's run window holds p99 ≤ 4 ms and
// GC ≤ 8 ms, and every bots check passes. If the browser skews the server's own checks (every
// FAIL is one of the server's tick or GC checks), the leg is repeated without --human and the two
// are judged separately: the server's numbers from the run without the browser, the rest from the
// run with it. The design's rule (§5 "16 + 1") named p99; Mustafa extended it to the GC pause on
// 2026-10-12 (D-045): on a 4-vCPU host the headless browser's software WebGL takes about two
// cores and stretches the server's GC pauses past 8 ms, while the same server without it stays
// near 4 ms, so the GC bound is judged without the browser unless the host has cores to spare.

const ARGS = [
  "--count",
  "16",
  "--profile",
  "wan-100-loss1",
  "--minutes",
  "2",
  "--map",
  "arena_greybox",
  "--strict",
];
/**
 * The server checks the browser can skew on a small host, judged from a run without it when they
 * are the only FAILs (design §5 "16 + 1" for p99; the GC pause by Mustafa's decision, D-045).
 */
const SERVER_SIDE = new Set(["server tick p50", "server tick p99", "server GC pause max"]);

function failing(s: BotsSummary): string[] {
  return s.checks.filter((c) => c.judged && !c.pass).map((c) => c.name);
}

function expectServer(s: BotsSummary, run: BotsCliRun): void {
  expect(s.config.server, run.md).toBe("child (dist)");
  expect(s.server?.beforeBotsS, run.md).toBe(0);
  // The generators below the server, which kept its own priority (D-045).
  expect(s.host.nice, run.md).toBe(10);
  expect(s.host.serverNice, run.md).not.toBeNull();
  expect(s.host.serverNice as number, run.md).toBeLessThan(10);
  for (const name of ["server tick p99", "server GC pause max"]) {
    const c = check(s, name);
    expect(c.pass, `${name}: ${c.value} (target ${c.target})\n${run.md}`).toBe(true);
  }
}

describe("16 bots + 1 human on arena_greybox at wan-100-loss1 (M3 acceptance, load tier)", () => {
  it("joins the human, keeps every remote smooth and the server inside its budget", async () => {
    await settleHost();
    const run = await runBotsCli([...ARGS, "--human"], "16-plus-1");
    const s = summaryOf(run);
    console.log(run.md);
    const h = s.human;
    if (h === null) throw new Error(`no human in the summary:\n${run.md}`);
    expect(s.config.maxClients, run.md).toBe(32);
    expect(s.host.nice).toBe(10);
    expect(check(s, "host gate (1-minute load before the run)").pass, run.md).toBe(true);
    // The human joined: 17 players, 16 drawn, and stayed.
    expect(h.joined, `the human never joined:\n${run.md}`).toBe(true);
    expect(h.players, run.md).toBe(17);
    expect(h.remotes, run.md).toBe(16);
    expect(h.closed, run.md).toBeNull();
    expect(h.errors, run.md).toEqual([]);
    // Its prediction by the e2e rule over the measured window, the profile's own starves excused
    // (wan-100-loss1 starves the bots' cmds on time too; NET-04's bounds below judge the rest).
    expectHealthy(
      { s: { ...h.start } },
      { s: { ...h.end } },
      { webSocket: true, lossyProfile: true },
    );
    expect(h.correctionsPerS, run.md).toBeLessThan(1);
    expect(h.meanCorrection, run.md).toBeLessThan(2);
    // Smooth remotes: no NET-05 violation on the page's frames that were not long, most judged.
    expect(h.remoteJumps, run.md).toBe(0);
    expect(h.remoteJudged, run.md).toBeGreaterThan(0);
    expect(h.interpDelay, run.md).toBeGreaterThanOrEqual(2);
    expect(h.interpDelay, run.md).toBeLessThanOrEqual(6);
    // What it drew: every bot's capsule (when WebGL is up) from snapshots it interpolated.
    if (h.end.webgl === "1") expect(h.end.capsules, run.md).toBe("16");
    expect(h.end.renderSnaps, run.md).toBe("0");
    const fails = failing(s);
    if (fails.length > 0 && fails.every((name) => SERVER_SIDE.has(name))) {
      // The fallback: the server's numbers from a run without the browser. The browser run's
      // server numbers go into the notes, so CI's records show how often it was needed.
      const beside = fails.map((name) => `${name} ${check(s, name).value}`).join(", ");
      console.log(`load: ${beside} beside the browser; repeating without --human`);
      await settleHost();
      const alone = await runBotsCli(ARGS, "16-plus-1-no-human");
      const a = summaryOf(alone);
      console.log(alone.md);
      writeNotes(
        "16-plus-1",
        `16 + 1: server checks skewed beside the browser (${beside}); the server judged without it: ` +
          `${[...SERVER_SIDE].map((name) => `${name} ${check(a, name).value}`).join(", ")}.`,
      );
      expectServer(a, alone);
      expect(failing(a), alone.md).toEqual([]);
      return;
    }
    expectServer(s, run);
    expect(fails, run.md).toEqual([]);
    expect(run.code, run.md).toBe(0);
  });
});
