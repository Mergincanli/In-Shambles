import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MATCH_NAME, startServer } from "@game/server/node";
import { describe, expect, it } from "vitest";
import {
  type Build,
  type BuildState,
  buildRefusal,
  buildState,
  buildWarning,
  CLIENT_BUILD,
  SERVER_BUILD,
} from "../../src/bots/builds";
import { BOTS_USAGE, botsMain, exitCode, parseBotArgs } from "../../src/bots/command";
import { descendants, lowerPriority, type PrioritySys, threadNiceness } from "../../src/bots/host";
import { humanQuery } from "../../src/bots/human";
import {
  BotsRefused,
  checkCount,
  hashRefusal,
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
      // Every CLI run checks the host and runs its generators at nice 10 (D-045).
      hostGate: true,
      nice: 10,
      outDir: fromRoot("reports", "bots"),
    });
    expect(
      parseBotArgs(
        [
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
          "--human",
          "--out",
          "x",
        ],
        "/typed/here",
      ),
    ).toMatchObject({
      human: true,
      count: 8,
      profile: "lan",
      minutes: 0.5,
      server: "ws://localhost:28700",
      seed: 7,
      strict: true,
      outDir: "/typed/here/x",
    });
  });

  it("resolves a relative --out against the directory the command was typed in (INIT_CWD)", () => {
    // pnpm runs the script from packages/tools; INIT_CWD is where `pnpm bots` was typed.
    const typedIn = join(tmpdir(), "typed-here");
    const saved = process.env.INIT_CWD;
    process.env.INIT_CWD = typedIn;
    try {
      expect(parseBotArgs(["--out", "../bots"]).outDir).toBe(resolve(typedIn, "../bots"));
      expect(parseBotArgs(["--out", "/abs/dir"]).outDir).toBe("/abs/dir");
      expect(parseBotArgs([]).outDir).toBe(fromRoot("reports", "bots"));
    } finally {
      if (saved === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = saved;
    }
  });

  it.each([[["--bogus"]], [["--count"]], [["--count", "many"]], [["stray"]]])(
    "refuses %j",
    (args) => {
      expect(() => parseBotArgs(args)).toThrow(BotsRefused);
    },
  );

  it("refuses a bad count, profile, length, map or server with exit code 2", async () => {
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
    // The human takes the 64th slot (D-045).
    expect(await run(["--human", "--count", "64"])).toBe(2);
    expect(await run(["--map", "../../etc/passwd"])).toBe(2);
    expect(await run(["--server", "ws//x"])).toBe(2);
    // A refused run keeps its caller's priority: it lowers its own only once it will run (D-045).
    const niceBefore = threadNiceness();
    expect(await run(["--server", "ws://127.0.0.1:1", "--count", "2"])).toBe(2);
    expect(threadNiceness()).toEqual(niceBefore);
    expect(await run(["--nope"])).toBe(2);
    expect(errors).toEqual([
      "bots: --count 0: expected 1–64",
      "bots: --count 65: expected 1–64",
      expect.stringMatching(/^bots: --profile dialup: expected one of lan, wan-50, /),
      "bots: --minutes 0: expected a positive number",
      "bots: --count 64: expected 1–63 with --human",
      "bots: --map ../../etc/passwd: expected a map id",
      "bots: --server ws//x: not a URL (expected ws://host:port)",
      expect.stringMatching(/^bots: http:\/\/127\.0\.0\.1:1\/status: no server answering \(/),
      expect.stringContaining(BOTS_USAGE),
    ]);
    // Clear messages, never a stack.
    for (const e of errors) expect(e).not.toMatch(/\n\s+at /);
  });

  it("stops a --strict run on a busy host before it starts: exit 1 with the numbers", async () => {
    const errors: string[] = [];
    const code = await botsMain(
      ["--strict", "--count", "2", "--server", "ws://127.0.0.1:1"],
      () => {},
      (t) => errors.push(t),
      { hostLoad: () => ({ load1: 3.2, cpus: 4 }), nice: 0 },
    );
    // Before any server is asked: port 1 would have refused it with exit 2.
    expect(code).toBe(1);
    expect(errors).toEqual([
      "bots: FAIL: host gate: load 3.20 on 4 CPUs = 0.80 per core > 0.5 before the run",
    ]);
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
    // The human's joined check counts the bots and itself: it needs a match with only them.
    expect(checkCount(16, true, { ...main, players: 1 })).toBe(
      "--human: match main already holds 1 players; the human's joined check needs a match " +
        "with only the bots",
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
    // Only what the server's listener addresses (D-047): `/`, `/m/<name>`, no query string.
    for (const bad of [
      "ws://127.0.0.1:1/lab",
      "ws://127.0.0.1:1/m/Lab",
      "ws://127.0.0.1:1/m/lab/",
      "ws://127.0.0.1:1/?m=lab",
      "ws://127.0.0.1:1/m/lab#x",
      "ws://127.0.0.1:1/m/lab#",
      "ws://127.0.0.1:1/m/lab?",
    ]) {
      expect(() => statusUrl(bad), bad).toThrow(/expected ws:\/\/host:port or .*\/m\/<match>/);
    }
    // The server's own name rule, name for name.
    for (const n of ["lab", "a_1", "x".repeat(32), "x".repeat(33), "Lab", "a-b", "__proto__"]) {
      const ok = (() => {
        try {
          statusUrl(`ws://127.0.0.1:1/m/${n}`);
          return true;
        } catch {
          return false;
        }
      })();
      expect(ok, n).toBe(MATCH_NAME.test(n));
    }
  });
});

describe("the human stand-in's page", () => {
  it("opens the scripted page on the server and profile, both encoded", () => {
    expect(humanQuery("ws://127.0.0.1:28700/m/a", "wan-100-loss1")).toBe(
      "?autotest=1&bot=mixed&connect=ws%3A%2F%2F127.0.0.1%3A28700%2Fm%2Fa&net_profile=wan-100-loss1",
    );
  });

  it("plays only the server's build (design §2.15)", () => {
    expect(hashRefusal("abc1234", "abc1234")).toBeNull();
    expect(hashRefusal("abc1234-dirty", "def5678")).toBe(
      "rebuild: preview abc1234-dirty ≠ server def5678",
    );
  });
});

describe("the builds a run plays", () => {
  const states = (server: BuildState, client: BuildState) => (b: Build) =>
    b === SERVER_BUILD ? server : b === CLIENT_BUILD ? client : "missing";

  it("refuses, under --strict, a server bundle it would start or a client build that is not fresh", () => {
    const own = { strict: true, human: false, ownServer: true };
    expect(buildRefusal(own, states("fresh", "missing"))).toBeNull();
    expect(buildRefusal(own, states("stale", "fresh"))).toBe(
      "--strict: server bundle packages/server/dist/main.js is older than its sources: " +
        "run pnpm build first",
    );
    expect(buildRefusal(own, states("missing", "fresh"))).toMatch(/main\.js is missing: run/);
    // A --server runs whatever it runs: only the page's build is this run's.
    const remote = { strict: true, human: true, ownServer: false };
    expect(buildRefusal(remote, states("missing", "fresh"))).toBeNull();
    expect(buildRefusal(remote, states("fresh", "stale"))).toBe(
      "--strict: client build packages/client/dist is older than its sources: run pnpm build first",
    );
  });

  it("falls back to the source without --strict, but serves the human only a build", () => {
    const plain = { strict: false, human: true, ownServer: true };
    expect(buildRefusal(plain, states("stale", "stale"))).toBeNull();
    expect(buildRefusal(plain, states("fresh", "missing"))).toBe(
      "--human: client build packages/client/dist is missing: run pnpm build first",
    );
    expect(buildRefusal({ ...plain, human: false }, states("missing", "missing"))).toBeNull();
  });

  it("warns a plain --human run that plays a stale page", () => {
    expect(buildWarning({ strict: false, human: true }, states("fresh", "stale"))).toBe(
      "warning: client build packages/client/dist is older than its sources: the human plays " +
        "the old client (pnpm build)",
    );
    expect(buildWarning({ strict: false, human: true }, states("fresh", "fresh"))).toBeNull();
    expect(buildWarning({ strict: true, human: true }, states("fresh", "stale"))).toBeNull();
    expect(buildWarning({ strict: false, human: false }, states("fresh", "stale"))).toBeNull();
  });

  it("knows which sources each build is made from", () => {
    expect(SERVER_BUILD.output).toBe(fromRoot("packages", "server", "dist", "main.js"));
    expect(CLIENT_BUILD.output).toBe(fromRoot("packages", "client", "dist", "index.html"));
    expect(SERVER_BUILD.sources).toEqual([
      fromRoot("packages", "server", "src"),
      fromRoot("packages", "shared", "src"),
      fromRoot("packages", "server", "build.mjs"),
      fromRoot("pnpm-lock.yaml"),
    ]);
    // The page bundles the Worker server's match code and `@game/server`'s entry (the Worker and
    // the console import it), the shared sim, and ships the maps.
    expect(CLIENT_BUILD.sources).toEqual([
      fromRoot("packages", "client", "src"),
      fromRoot("packages", "client", "index.html"),
      fromRoot("packages", "client", "vite.config.ts"),
      fromRoot("packages", "shared", "src"),
      fromRoot("packages", "server", "src", "index.ts"),
      fromRoot("packages", "server", "src", "match"),
      fromRoot("content", "maps"),
      fromRoot("pnpm-lock.yaml"),
    ]);
  });

  it("calls a build stale when any source, nested, added or deleted, is newer", ({
    onTestFinished,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "bots-builds-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const src = join(dir, "src");
    mkdirSync(join(src, "deep"), { recursive: true });
    for (const f of ["a.ts", "deep/b.ts", "deep/c.ts"]) writeFileSync(join(src, f), f);
    writeFileSync(join(dir, "build.mjs"), "");
    const b: Build = {
      name: "test build",
      output: join(dir, "out.js"),
      sources: [src, join(dir, "build.mjs")],
    };
    const old = Date.now() / 1000 - 100;
    const age = (path: string, t: number) => utimesSync(path, t, t);
    const ageAll = () => {
      for (const p of ["a.ts", "deep/b.ts", "deep/c.ts", "deep", "."]) age(join(src, p), old);
      age(join(dir, "build.mjs"), old);
    };
    ageAll();
    expect(buildState(b)).toBe("missing");
    writeFileSync(b.output, "");
    age(b.output, old + 50);
    expect(buildState(b)).toBe("fresh");
    // One nested file edited after the build.
    age(join(src, "deep", "b.ts"), old + 60);
    expect(buildState(b)).toBe("stale");
    ageAll();
    age(join(dir, "build.mjs"), old + 60);
    expect(buildState(b)).toBe("stale");
    ageAll();
    expect(buildState(b)).toBe("fresh");
    // A deleted source changes its folder's time: the bundle still holds its code.
    rmSync(join(src, "deep", "c.ts"));
    expect(buildState(b)).toBe("stale");
    age(join(src, "deep"), old);
    expect(buildState(b)).toBe("fresh");
    rmSync(join(src, "a.ts"));
    expect(buildState(b)).toBe("stale");
  });
});

describe("the generators' priority", () => {
  /** A fake process: thread ids with their niceness, or one process-wide value (macOS). */
  const fake = (threads: Record<string, number> | null, own = 0) => {
    const nice = new Map<number, number>(
      Object.entries(threads ?? { 0: own }).map(([k, v]) => [Number(k), v]),
    );
    const sys: PrioritySys = {
      threads: () => (threads === null ? null : Object.keys(threads)),
      set: (id, n) => {
        if (id === 13) throw new Error("ESRCH");
        nice.set(id === 0 && threads !== null ? 100 : id, n);
      },
      get: (id) => nice.get(id === 0 && threads !== null ? 100 : id) ?? 0,
    };
    return { nice, sys };
  };

  it("renices every thread on Linux and only ever lowers the priority", () => {
    const p = fake({ 100: 0, 101: 0, 102: 15, 13: 0 });
    expect(lowerPriority(10, p.sys)).toBe(10);
    // The thread that exited meanwhile is left; one already lower keeps its 15.
    expect(Object.fromEntries(p.nice)).toEqual({ 100: 10, 101: 10, 102: 15, 13: 0 });
  });

  it("sets the process's own priority where a process has one", () => {
    const p = fake(null);
    expect(lowerPriority(10, p.sys)).toBe(10);
  });

  it("holds every process below the runner but the server child's tree", () => {
    // 1 → runner 10 → server 11 (→ 12), browser 20 → gpu 21, renderer 22; 30 is unrelated.
    const parentOf = new Map([
      [10, 1],
      [11, 10],
      [12, 11],
      [20, 10],
      [21, 20],
      [22, 20],
      [30, 1],
    ]);
    expect(descendants(10, parentOf, new Set([11])).sort()).toEqual([20, 21, 22]);
    expect(descendants(10, parentOf, new Set()).sort()).toEqual([11, 12, 20, 21, 22]);
    expect(descendants(30, parentOf, new Set())).toEqual([]);
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
    // Two matches (D-047): the check reads the match the URL addresses.
    const server = await startServer({
      args: ["--port", "0", "--set", "sv_maxClients=4"].concat([
        "--match",
        "a=movement_lab",
        "--match",
        "b=movement_lab:3",
      ]),
      cwd: fromRoot("packages", "server"),
      primer: false,
    });
    onTestFinished(() => server.stop());
    const run = (count: number, path: string) =>
      runBots({
        count,
        profile: "lan",
        minutes: 0.05,
        map: "movement_lab",
        server: `ws://127.0.0.1:${server.listener.port}${path}`,
        seed: 1,
        human: false,
        outDir: null,
        primer: false,
      });
    await expect(run(5, "/")).rejects.toThrow(new BotsRefused("count 5 > maxClients 4 on match a"));
    await expect(run(4, "/m/b")).rejects.toThrow(
      new BotsRefused("count 4 > maxClients 3 on match b"),
    );
    expect(server.matches.a?.match.sessionCount).toBe(0);
    expect(server.matches.b?.match.sessionCount).toBe(0);
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
    // Node's own warnings (a timer it had to clamp, D-045's frame loop before any bot is in).
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(`${w.name}: ${w.message}`);
    process.on("warning", onWarning);
    onTestFinished(() => {
      process.off("warning", onWarning);
    });
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
      // A busy host without --strict: the run goes ahead, the gate a FAIL row (D-045).
      hostGate: true,
      hostLoad: () => ({ load1: 3.2, cpus: 4 }),
    });
    expect(lines[0]).toMatch(/^bots: 3 on arena_greybox \(match main, maxClients 32\) at wan-50/);
    expect(lines[1]).toBe(
      "bots: FAIL host gate: load 3.20 on 4 CPUs = 0.80 per core > 0.5 before the run",
    );
    expect(summary.checks[0]).toMatchObject({
      name: "host gate (1-minute load before the run)",
      pass: false,
      judged: true,
    });
    expect(summary.pass).toBe(false);
    // An in-process run keeps its priority; a --server has no child to read.
    expect(summary.host).toMatchObject({
      cpus: 4,
      loadAvg1Start: 3.2,
      nice: null,
      serverNice: null,
    });
    expect(warnings.filter((w) => w.startsWith("TimeoutOverflowWarning"))).toEqual([]);
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
  /** A /metrics reading after `runS` s (the match's window `matchS`) with the counters given. */
  const metrics = (runS: number, n: number, maxStaleness: number, matchS = runS) => ({
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
        runS: matchS,
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
    const windowed = serverSection(
      metrics(30, 3, 2),
      "default",
      "x",
      64,
      metrics(10, 1, 1),
      20,
      20,
    );
    expect([
      windowed.snapshots,
      windowed.fullSnapshots,
      windowed.deferredSnapshots,
      windowed.deferredEntities,
      windowed.maxStaleness,
      windowed.snapshotOverflow,
    ]).toEqual([2000, 2, 200, 5800, 2, 0]);
  });

  it("takes the end's counters whole when the run window restarted between the readings", () => {
    // Read at 3 s into the window, again 60 s later: a 50 s window restarted (the discard ended).
    const restarted = serverSection(
      metrics(50, 3, 2),
      "default",
      "x",
      64,
      metrics(3, 1, 1),
      60,
      60,
    );
    expect([restarted.snapshots, restarted.fullSnapshots, restarted.deferredEntities]).toEqual([
      3000, 3, 8700,
    ]);
    // A window that grew by the time between the readings (a second of slack) did not restart.
    const kept = serverSection(metrics(62, 3, 2), "default", "x", 64, metrics(3, 1, 1), 60, 60);
    expect(kept.snapshots).toBe(2000);
  });

  it("follows the match's own window for its counters: a per-match reset restarts it alone", () => {
    // `metrics reset main` (rcon or the console) 40 s into the bots' 60 s: the process's window
    // ran on, the match's is 20 s old, so its counters lie inside the bots' window already.
    const end = metrics(160, 3, 2, 20);
    const reset = serverSection(end, "default", "x", 64, metrics(100, 1, 1), 60, 60);
    expect([reset.snapshots, reset.strikes, reset.deferredEntities]).toEqual([3000, 0, 8700]);
    expect(reset.snapshots).toBeGreaterThan(0);
  });
});
