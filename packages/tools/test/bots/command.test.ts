import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "@game/server/node";
import { describe, expect, it } from "vitest";
import { BOTS_USAGE, botsMain, exitCode, parseBotArgs } from "../../src/bots/command";
import {
  BotsRefused,
  checkCount,
  matchOf,
  runBots,
  type ServerStatus,
  serverSection,
  statusUrl,
} from "../../src/bots/runner";
import { serverChildArgs } from "../../src/bots/serverChild";
import type { BotsSummary } from "../../src/bots/summary";
import { fromRoot } from "../../src/paths";

// `pnpm bots` (M3 design §2.15, §5 "Bots", D-036): its flags, the count check against the
// match's maxClients from /status, the server child's flags (sv_maxClients only above 30 bots),
// and a short real run: 3 bots against an in-process server, writing the JSON + markdown summary.
// The runs with a server child (2 bots against it, and a child that dies mid-run, which still
// leaves a summary) and a terminal's Ctrl+C are the long tier's (D-032;
// `packages/tools/long/bots-server-child.long.ts` and `bots-interrupt.long.ts`).

describe("pnpm bots flags", () => {
  it("defaults to 16 bots at wan-100-loss1 for 2 min on arena_greybox, into reports/bots", () => {
    expect(parseBotArgs([])).toEqual({
      count: 16,
      profile: "wan-100-loss1",
      minutes: 2,
      map: "arena_greybox",
      server: null,
      seed: 1,
      human: false,
      strict: false,
      outDir: fromRoot("reports", "bots"),
    });
    expect(
      parseBotArgs([
        "--count",
        "8",
        "--profile",
        "lan",
        "--minutes",
        "0.5",
        "--server",
        "ws://localhost:28700",
        "--seed",
        "7",
        "--strict",
        "--out",
        "x",
      ]),
    ).toMatchObject({
      count: 8,
      profile: "lan",
      minutes: 0.5,
      server: "ws://localhost:28700",
      seed: 7,
      strict: true,
      outDir: "x",
    });
  });

  it.each([[["--bogus"]], [["--count"]], [["--count", "many"]], [["stray"]]])(
    "refuses %j",
    (args) => {
      expect(() => parseBotArgs(args)).toThrow(BotsRefused);
    },
  );

  it("refuses a bad count, profile, length or --human (increment 18) with exit code 2", async () => {
    const errors: string[] = [];
    const run = (args: string[]) =>
      botsMain(
        args,
        () => {},
        (t) => errors.push(t),
      );
    expect(await run(["--count", "0"])).toBe(2);
    expect(await run(["--count", "65"])).toBe(2);
    expect(await run(["--profile", "dialup"])).toBe(2);
    expect(await run(["--minutes", "0"])).toBe(2);
    expect(await run(["--human"])).toBe(2);
    expect(await run(["--map", "../../etc/passwd"])).toBe(2);
    expect(await run(["--server", "ws//x"])).toBe(2);
    expect(await run(["--server", "ws://127.0.0.1:1", "--count", "2"])).toBe(2);
    expect(await run(["--nope"])).toBe(2);
    expect(errors).toEqual([
      "bots: --count 0: expected 1–64",
      "bots: --count 65: expected 1–64",
      expect.stringMatching(/^bots: --profile dialup: expected one of lan, wan-50, /),
      "bots: --minutes 0: expected a positive number",
      "bots: --human: the headless browser player arrives with M3 increment 18 (D-045)",
      "bots: --map ../../etc/passwd: expected a map id",
      "bots: --server ws//x: not a URL (expected ws://host:port)",
      expect.stringMatching(/^bots: http:\/\/127\.0\.0\.1:1\/status: no server answering \(/),
      expect.stringContaining(BOTS_USAGE),
    ]);
    // Clear messages, never a stack.
    for (const e of errors) expect(e).not.toMatch(/\n\s+at /);
  });

  it("exits 1 on a FAIL only under --strict", () => {
    expect(exitCode(true, false)).toBe(0);
    expect(exitCode(true, true)).toBe(0);
    expect(exitCode(false, false)).toBe(0);
    expect(exitCode(false, true)).toBe(1);
  });
});

describe("the count check (maxClients from /status)", () => {
  const main = { name: "main", map: "arena_greybox", players: 0, maxClients: 37 };

  it("lets a count in up to the match's maxClients, a human counting as one more", () => {
    expect(checkCount(37, false, main)).toBeNull();
    expect(checkCount(36, true, main)).toBeNull();
    expect(checkCount(16, true, { ...main, maxClients: 32 })).toBeNull();
  });

  it("refuses one past it with the reason", () => {
    expect(checkCount(38, false, main)).toBe("count 38 > maxClients 37 on match main");
    expect(checkCount(40, true, main)).toBe("count 40 + human > maxClients 37 on match main");
    expect(checkCount(30, false, { ...main, players: 3, maxClients: 32 })).toBe(
      "count 30 + 3 players already in > maxClients 32 on match main",
    );
  });

  it("finds the match a server URL names, and its /status page", () => {
    const status: ServerStatus = {
      buildHash: "h",
      protocol: 2,
      matches: [main, { ...main, name: "lab", map: "movement_lab" }],
    };
    expect(matchOf("ws://127.0.0.1:1/", status).name).toBe("main");
    expect(matchOf("ws://127.0.0.1:1", status).name).toBe("main");
    expect(matchOf("ws://127.0.0.1:1/m/lab", status).name).toBe("lab");
    expect(() => matchOf("ws://127.0.0.1:1/m/duel", status)).toThrow(/no match duel/);
    expect(statusUrl("ws://example.org:28700/m/lab")).toBe("http://example.org:28700/status");
    expect(() => statusUrl("wss://example.org")).toThrow(BotsRefused);
  });
});

describe("the server child's flags", () => {
  it("leave sv_maxClients at its default 32 up to 30 bots, and raise it to count + 2 above", () => {
    const base = [
      "--port",
      "0",
      "--map",
      "arena_greybox",
      "--metrics-out",
      "m.json",
      "--metrics-discard",
      "10",
    ];
    expect(serverChildArgs(16, "arena_greybox", "m.json", 10)).toEqual(base);
    expect(serverChildArgs(30, "arena_greybox", "m.json", 10)).toEqual(base);
    expect(serverChildArgs(31, "arena_greybox", "m.json", 10)).toEqual([
      ...base,
      "--set",
      "sv_maxClients=33",
    ]);
    expect(serverChildArgs(63, "arena_greybox", "m.json", 10)).toEqual([
      ...base,
      "--set",
      "sv_maxClients=64",
    ]);
  });
});

function outDir(onFinished: (fn: () => void) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "bots-run-"));
  onFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe.concurrent("a bots run", () => {
  it("refuses a count over the match's maxClients before connecting", async ({
    onTestFinished,
  }) => {
    const server = await startServer({
      args: ["--port", "0", "--set", "sv_maxClients=4"],
      cwd: fromRoot("packages", "server"),
      primer: false,
    });
    onTestFinished(() => server.stop());
    const url = `ws://127.0.0.1:${server.listener.port}/`;
    const run = runBots({
      count: 5,
      profile: "lan",
      minutes: 0.05,
      map: "arena_greybox",
      server: url,
      seed: 1,
      human: false,
      outDir: null,
      primer: false,
    });
    await expect(run).rejects.toThrow(new BotsRefused("count 5 > maxClients 4 on match main"));
    expect(server.matches.main?.match.sessionCount).toBe(0);
  });

  it("plays 3 bots against a server and writes the JSON + markdown summary", async ({
    expect,
    onTestFinished,
  }) => {
    // Strict builds: a bot sending any hash but the server's would be KICKed and fail the run.
    const server = await startServer({
      args: ["--port", "0", "--set", "sv_strictBuild=1"],
      cwd: fromRoot("packages", "server"),
      primer: false,
    });
    onTestFinished(() => server.stop());
    const dir = outDir(onTestFinished);
    const lines: string[] = [];
    const { summary, files } = await runBots({
      count: 3,
      profile: "wan-50",
      minutes: 0.05,
      map: "arena_greybox",
      server: `ws://127.0.0.1:${server.listener.port}/`,
      seed: 3,
      human: false,
      outDir: dir,
      primer: false,
      log: (t) => lines.push(t),
    });
    expect(lines[0]).toMatch(/^bots: 3 on arena_greybox \(match main, maxClients 32\) at wan-50/);
    expect(summary.config).toMatchObject({
      count: 3,
      buildHash: server.buildHash,
      server: `ws://127.0.0.1:${server.listener.port}/`,
    });
    expect(summary.aggregate).toMatchObject({ joined: 3, closed: 0, strikes: 0 });
    expect(summary.bots.map((b) => b.behaviour)).toEqual(["route", "route", "route"]);
    for (const b of summary.bots) {
      expect(b.snapshots, `bot ${b.id}`).toBeGreaterThan(100);
      // Deltas against the acked frames (D-038) once the bots are in: at most the worst delta of
      // two other players, 312 + 2 × 233 bits (98 B); measured about 30 B, 2.1 KB/s down, where
      // full snapshots (90 B: 86 + 199 + 7 + 2 × 213 bits) would take 5.5 KB/s.
      expect(b.deltaShare, `bot ${b.id}`).toBeGreaterThan(0.9);
      expect(b.snapshotBytes.max, `bot ${b.id}`).toBeLessThanOrEqual(98);
      expect(b.kbDownPerS, `bot ${b.id}`).toBeGreaterThan(1);
      expect(b.kbDownPerS, `bot ${b.id}`).toBeLessThan(4.5);
      expect(b.kbUpPerS, `bot ${b.id}`).toBeGreaterThan(2);
    }
    expect(summary.server).toMatchObject({
      source: "GET /metrics",
      players: 3,
      strikes: 0,
      kicks: 0,
      rateLimited: 0,
    });
    // The server's counters are the bots' window's (end minus start of /metrics); its run window
    // began at listen, before the bots, so the tick checks are reported, not judged.
    const s = summary.server;
    if (s === null) throw new Error("no server section");
    expect(s.beforeBotsS).toBeGreaterThan(0);
    expect(s.kbOutPerS).toBeGreaterThan(3 * 1);
    // Deltas once each bot's first ack arrived (D-038): the joins' full snapshots come before the
    // bots' window (measured 0 in it), so at most a stray one per bot.
    expect(s.fullSnapshots).toBeLessThanOrEqual(3);
    expect(summary.checks.find((c) => c.name === "server tick p99")?.judged).toBe(false);
    expect(summary.aggregate.mispredictions).toBe(0);
    // Each bot drew the two others interpolated and smooth (D-037), NET-05 judging most of its
    // remote-frames (2 others on every frame that was not long).
    expect(summary.aggregate.remoteJumps).toBe(0);
    for (const b of summary.bots) {
      expect(b.remoteJudged, `bot ${b.id}`).toBeGreaterThan(b.snapshots);
      expect(b.interpDelay.max, `bot ${b.id}`).toBeGreaterThanOrEqual(2);
      expect(b.interpDelay.max, `bot ${b.id}`).toBeLessThanOrEqual(6);
    }
    // Every bot left at the end.
    await expect.poll(() => server.matches.main?.match.sessionCount).toBe(0);
    if (files === null) throw new Error("no files");
    const json = JSON.parse(readFileSync(files.json, "utf8")) as BotsSummary;
    expect(json).toEqual(JSON.parse(JSON.stringify(summary)));
    expect(readFileSync(files.md, "utf8")).toMatch(/^# Bots run .*: (PASS|FAIL)\n/);
  }, 20_000);
});

describe("the summary's server section from /metrics", () => {
  /** A /metrics reading after `runS` s with the scheduler counters given. */
  const metrics = (runS: number, n: number, maxStaleness: number) => ({
    process: {
      runS,
      tickUs: { p50: 1, p95: 2, p99: 3, max: 4 },
      gc: { count: 0, maxMs: 0 },
      memoryMB: { heapUsed: 1, external: 1, rss: 1, peakHeapExternal: 1, peakRss: 1 },
      cpuMsPerWallS: 10,
      droppedTicks: 0,
    },
    matches: {
      default: {
        starved: 0,
        snapshots: 1000 * n,
        fullSnapshots: n,
        deferredSnapshots: 100 * n,
        deferredEntities: 2900 * n,
        maxStaleness,
        snapshotOverflow: 0,
        strikes: 0,
        kicks: 0,
        rateLimited: 0,
        inputPackets: 990 * n,
        inputLost: 10 * n,
        traffic: { bytesIn: 0, bytesOut: 0, kbInPerS: 0, kbOutPerS: 0 },
      },
    },
  });

  it("takes the scheduler counters over the bots' window, the staleness as a running maximum", () => {
    const whole = serverSection(metrics(30, 3, 2), "default", "x", 64, null, 30);
    expect([whole.snapshots, whole.deferredSnapshots, whole.deferredEntities]).toEqual([
      3000, 300, 8700,
    ]);
    const windowed = serverSection(metrics(30, 3, 2), "default", "x", 64, metrics(10, 1, 1), 20);
    expect([
      windowed.snapshots,
      windowed.fullSnapshots,
      windowed.deferredSnapshots,
      windowed.deferredEntities,
      windowed.maxStaleness,
      windowed.snapshotOverflow,
    ]).toEqual([2000, 2, 200, 5800, 2, 0]);
  });
});
