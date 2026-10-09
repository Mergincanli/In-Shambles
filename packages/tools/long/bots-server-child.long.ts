import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBots } from "../src/bots/runner";

// `pnpm bots` with its own server child (M3 design §2.15, §5 "Bots", D-036), the long tier's
// (D-032): 2 bots against a server child it starts, reading the child's metrics file, and a child
// that dies mid-run, which still leaves a summary naming why. Real processes on real time (the
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
    onTestFinished,
  }) => {
    const dir = outDir(onTestFinished);
    const { summary, files } = await runBots({
      count: 2,
      profile: "lan",
      minutes: 0.04,
      map: "arena_greybox",
      server: null,
      seed: 1,
      human: false,
      outDir: dir,
    });
    expect(summary.config.server).toMatch(/^child \((dist|tsx)\)$/);
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
});
