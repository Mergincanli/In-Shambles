import { describe, expect, it } from "vitest";
import { runBotsCli, settleHost, summaryOf, writeNotes } from "./helpers";

// A full server, reported, not gated (M3 design §2.16, §5; D-045, D-046): one 63-bot match on
// arena_greybox at wan-100-loss1 for 1 min, the bots' child at sv_maxClients 64 (the runner raises
// it above 30 bots) with the byte-budget scheduler leaving players out, the bots at nice 10.
// docs/10 §4.1 budgets 16 players, so the numbers (tick p99, the deferral share, max staleness,
// bandwidth) are recorded (`reports/load/full-server/`) and the leg fails only when it did not run
// on the bundle.

describe("load (reported): one 63-bot match", () => {
  it("runs and records the server's numbers with the scheduler at work", async () => {
    await settleHost();
    const run = await runBotsCli(
      ["--count", "63", "--profile", "wan-100-loss1", "--minutes", "1", "--map", "arena_greybox"],
      "full-server",
    );
    const s = summaryOf(run);
    console.log(run.md);
    // The numbers are the bundle's: a stale one would quietly measure the source under tsx.
    expect(s.config.server, `pnpm build first: the leg measures the bundle\n${run.md}`).toBe(
      "child (dist)",
    );
    expect(s.config.maxClients, run.md).toBe(64);
    expect(s.aggregate.joined, run.md).toBe(63);
    const v = s.server;
    writeNotes(
      "full-server",
      v === null
        ? "No server numbers."
        : `63 bots: tick p50 ${v.tickUs.p50} µs, p99 ${v.tickUs.p99} µs, max ${v.tickUs.max} µs; ` +
            `GC max ${v.gc.maxMs} ms; peak heapUsed + external ${v.memoryMB.peakHeapExternal} MB; ` +
            `${v.deferredEntities} players left out of ${v.deferredSnapshots} of ${v.snapshots} ` +
            `snapshots, max staleness ${v.maxStaleness}; server out ${v.kbOutPerS} KB/s, in ` +
            `${v.kbInPerS} KB/s; per bot down ${s.aggregate.kbDownPerS.mean} KB/s (worst ` +
            `${s.aggregate.kbDownPerS.max}, peak 1 s ${s.aggregate.kbDownPeak}), up ` +
            `${s.aggregate.kbUpPerS.mean} KB/s; ${s.pass ? "PASS" : "FAIL"} against the ` +
            "16-player budgets.",
    );
  });
});
