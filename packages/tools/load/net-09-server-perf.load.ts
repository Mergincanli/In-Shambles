import { describe, expect, it } from "vitest";
import { check, runBotsCli, settleHost, summaryOf } from "./helpers";

// NET-09 proper (docs/05 §14, M3 design §5, D-045): the built server bundle as the bots' child,
// 16 bots over real WebSockets at wan-100-loss1 for 1 min on arena_greybox, the bots (and nothing
// else this run starts) at nice 10. The server discards its first 10 s (`--metrics-discard`, the
// bots' default), so the run window it judges is the steady match after the joins: the loop
// pass's tick p50 ≤ 1.5 ms and p99 ≤ 4 ms, no GC pause over 8 ms, the window's peak heapUsed +
// external ≤ 150 MB (RSS reported). `--strict` refuses a bundle older than its sources and a host
// above 0.5 load per core before the run: both fail this leg with the reason, never skip it. The
// fast in-process proxy is `packages/tools/test/net/net-09-server-perf.test.ts`.

const SERVER_CHECKS = [
  "server tick p50",
  "server tick p99",
  "server GC pause max",
  "server memory (peak heapUsed + external)",
];

describe("NET-09: server performance with 16 bots on the real server (load tier)", () => {
  it("holds tick p50 ≤ 1.5 ms, p99 ≤ 4 ms, GC ≤ 8 ms and memory ≤ 150 MB after the discard", async () => {
    await settleHost();
    const run = await runBotsCli(
      [
        "--count",
        "16",
        "--profile",
        "wan-100-loss1",
        "--minutes",
        "1",
        "--map",
        "arena_greybox",
        "--strict",
      ],
      "net-09",
    );
    // A refused run (a stale bundle) or a busy host fails here with the CLI's reason.
    const s = summaryOf(run);
    console.log(run.md);
    expect(s.config.server, run.md).toBe("child (dist)");
    // The generators at nice 10, the server child at its own priority above them (D-045).
    expect(s.host.nice).toBe(10);
    expect(s.host.serverNice, run.md).not.toBeNull();
    expect(s.host.serverNice as number, run.md).toBeLessThan(10);
    expect(check(s, "host gate (1-minute load before the run)").pass, run.md).toBe(true);
    expect(s.server, run.md).not.toBeNull();
    expect(s.server?.source).toBe("--metrics-out");
    expect(s.server?.beforeBotsS).toBe(0);
    expect(s.server?.players).toBe(16);
    expect(s.aggregate.joined).toBe(16);
    for (const name of SERVER_CHECKS) {
      const c = check(s, name);
      expect(c.judged, name).toBe(true);
      expect(c.pass, `${name}: ${c.value} (target ${c.target})\n${run.md}`).toBe(true);
    }
  });
});
