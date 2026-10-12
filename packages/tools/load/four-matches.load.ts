import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startServerChild } from "../src/bots/serverChild";
import { runBotsCli, settleHost, summaryOf, writeNotes } from "./helpers";

// Several matches on one process, reported, not gated (M3 design §2.17, D-045, D-047): the built
// server with 4 arena_greybox matches (a–d; `sv_maxTotalClients` 72, room for the 64 bots), and
// 4 `pnpm bots --count 16 --server ws://…/m/<match>` runs side by side for 1 min, each at nice 10.
// The judge would be the loop pass, which times every match (docs/10 §4.1 budgets one 16-player
// match, so `sv_maxMatches` 4's default is revisited with these numbers): its tick p50/p99/max,
// each match's own p50/p99/max, GC, memory and dropped ticks over the run window after a 10 s
// discard, from the server's `--metrics-out`, and each match's bots summary, recorded in
// `reports/load/four-matches/`.

const MATCHES = ["a", "b", "c", "d"];

interface ProcessMetrics {
  /** Each match's own tick times over its window (the per-match p99 of design §5). */
  matches: Record<string, { tickUs: { p50: number; p99: number; max: number } }>;
  process: {
    runS: number;
    tickUs: { p50: number; p95: number; p99: number; max: number };
    gc: { count: number; maxMs: number };
    memoryMB: { peakHeapExternal: number; peakRss: number };
    cpuMsPerWallS: number;
    droppedTicks: number;
  };
}

describe("load (reported): 4 matches × 16 bots on one server", () => {
  it("runs and records the loop pass's numbers", async () => {
    await settleHost();
    const dir = mkdtempSync(join(tmpdir(), "load-four-matches-"));
    const metricsOut = join(dir, "metrics.json");
    const server = await startServerChild([
      "--port",
      "0",
      ...MATCHES.flatMap((m) => ["--match", `${m}=arena_greybox`]),
      "--set",
      "sv_maxTotalClients=72",
      "--metrics-out",
      metricsOut,
      "--metrics-discard",
      "10",
    ]);
    try {
      expect(server.kind, "pnpm build first: the leg measures the bundle").toBe("dist");
      const runs = await Promise.all(
        MATCHES.map((m) =>
          runBotsCli(
            [
              "--count",
              "16",
              "--profile",
              "wan-100-loss1",
              "--minutes",
              "1",
              "--map",
              "arena_greybox",
              "--server",
              `ws://127.0.0.1:${server.port}/m/${m}`,
              "--seed",
              String(1 + 100 * MATCHES.indexOf(m)),
            ],
            `four-matches-${m}`,
          ),
        ),
      );
      const summaries = runs.map(summaryOf);
      for (const r of runs) console.log(r.md);
      for (const s of summaries) expect(s.aggregate.joined).toBe(16);
      expect(await server.stop()).toBe(0);
      expect(existsSync(metricsOut)).toBe(true);
      const metrics = JSON.parse(readFileSync(metricsOut, "utf8")) as ProcessMetrics;
      const p = metrics.process;
      const perMatch = MATCHES.map((m) => {
        const t = metrics.matches[m]?.tickUs;
        return t === undefined ? `${m} –` : `${m} p50 ${t.p50} / p99 ${t.p99} / max ${t.max} µs`;
      }).join(", ");
      const line =
        `4 matches × 16 bots: the loop pass over ${p.runS.toFixed(1)} s: tick p50 ${p.tickUs.p50} µs, ` +
        `p95 ${p.tickUs.p95} µs, p99 ${p.tickUs.p99} µs, max ${p.tickUs.max} µs; ` +
        `per match ${perMatch}; ${p.droppedTicks} dropped ticks; GC ${p.gc.count} pauses, max ${p.gc.maxMs} ms; peak ` +
        `heapUsed + external ${p.memoryMB.peakHeapExternal} MB, peak RSS ${p.memoryMB.peakRss} MB; ` +
        `${p.cpuMsPerWallS} CPU-ms per wall s. Bots: ` +
        summaries.map((s) => `${s.config.match} ${s.pass ? "PASS" : "FAIL"}`).join(", ");
      console.log(line);
      writeNotes("four-matches", line);
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
