import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBots } from "../src/bots/runner";
import {
  QUIT_GRACE_MS,
  type ServerChild,
  serverChildArgs,
  startServerChild,
} from "../src/bots/serverChild";

// `pnpm bots` with its own server child (M3 design §2.15, §5 "Bots", D-036), the long tier's
// (D-032): 2 bots against a server child it starts and stops with the stdin `quit` (D-051),
// reading the child's metrics file, a child whose stdin is gone (SIGTERM at once on POSIX), and a
// child that dies mid-run, which still leaves a summary naming why. Real processes on real time (the
// server from its bundle or from source under tsx), side by side. The flags, the count check and
// a real run against an in-process server stay in `pnpm test`
// (`packages/tools/test/bots/command.test.ts`).

function outDir(onFinished: (fn: () => void) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "bots-run-"));
  onFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe.concurrent("a bots run", () => {
  it("starts its own server child when no --server is given, and reads its metrics file", async ({
    expect,
    onTestFinished,
  }) => {
    const dir = outDir(onTestFinished);
    const children: ServerChild[] = [];
    const { summary, files } = await runBots({
      count: 2,
      profile: "lan",
      // 4.8 s, so the child discards its first 1.2 s (a quarter): on a loaded host making the bots
      // (ClientSims with their primer) took past the 0.6 s a 0.04-minute run gives, and the window
      // then began before them (beforeBotsS 0.08–0.11 s, M3 increment 15's runs).
      minutes: 0.08,
      map: "arena_greybox",
      server: null,
      seed: 1,
      human: false,
      outDir: dir,
      onServerChild: (c) => children.push(c),
    });
    expect(summary.config.server).toMatch(/^child \((dist|tsx)\)$/);
    // Stopped by `quit` on its stdin, the stop it has on every platform (D-051): exit 0 after the
    // shutdown that wrote the metrics file read below.
    expect(children).toHaveLength(1);
    const child = children[0] as ServerChild;
    await expect
      .poll(() => child.lines.filter((l) => l.ev === "shutdown").map((l) => l.signal))
      .toEqual(["quit"]);
    expect(child.child.exitCode).toBe(0);
    expect(summary.config.maxClients).toBe(32);
    expect(summary.aggregate.joined).toBe(2);
    expect(summary.server).toMatchObject({ source: "--metrics-out", players: 2, beforeBotsS: 0 });
    expect(summary.server?.runS).toBeGreaterThan(0);
    expect(summary.server?.memoryMB.peakHeapExternal).toBeGreaterThan(0);
    expect(summary.checks.every((c) => c.judged)).toBe(true);
    expect(files !== null && existsSync(files.md)).toBe(true);
  }, 30_000);

  it("still writes the summary, naming why, when its server child dies mid-run", async ({
    onTestFinished,
  }) => {
    const dir = outDir(onTestFinished);
    const { summary, files } = await runBots({
      count: 2,
      profile: "lan",
      minutes: 0.05,
      map: "arena_greybox",
      server: null,
      seed: 1,
      human: false,
      outDir: dir,
      onServerChild: (child) => {
        setTimeout(() => child.child.kill("SIGKILL"), 2500);
      },
    });
    expect(summary.server).toBeNull();
    expect(summary.pass).toBe(false);
    expect(summary.checks.find((c) => c.name === "server metrics")?.value).toMatch(
      /^the server child exited \(code null\) during the run$/,
    );
    expect(summary.aggregate.closed).toBe(2);
    expect(files !== null && existsSync(files.json)).toBe(true);
  }, 30_000);

  // D-051's POSIX fallback: a child that can't be sent `quit` (its stdin gone) gets SIGTERM at
  // once, not after the grace that waits for a `quit`, and stops on it as cleanly.
  it.skipIf(process.platform === "win32")(
    "SIGTERMs a server child whose stdin is gone at once, and it stops cleanly",
    async ({ expect, onTestFinished }) => {
      const dir = outDir(onTestFinished);
      const metrics = join(dir, "metrics.json");
      const child = await startServerChild(serverChildArgs(1, "arena_greybox", metrics, 0));
      onTestFinished(() => void child.stop());
      child.child.stdin?.destroy();
      const t0 = performance.now();
      const code = await child.stop();
      expect(performance.now() - t0).toBeLessThan(QUIT_GRACE_MS);
      expect(code).toBe(0);
      expect(child.lines.filter((l) => l.ev === "shutdown").map((l) => l.signal)).toEqual([
        "SIGTERM",
      ]);
      expect(existsSync(metrics)).toBe(true);
    },
    30_000,
  );
});
