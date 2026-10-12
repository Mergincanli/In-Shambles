import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { BotsSummary } from "../src/bots/summary";
import { fromRoot } from "../src/paths";

// A terminal's Ctrl+C on `pnpm bots` (D-036, docs/10 §2): the terminal sends SIGINT to the whole
// foreground process group. The bots CLI runs here in a group of its own, as a shell would start
// it, starts its server child, and gets the group's SIGINT a few seconds into the window. The
// child sits in its own group (`detached`), so the SIGINT reaches only the bots, which end the
// window, stop the child themselves and still write the summary with the child's metrics file.
// Real processes on real time (about 8 s), so the long tier's.

const POSIX = process.platform !== "win32";

describe.runIf(POSIX)("pnpm bots under a terminal's Ctrl+C", () => {
  it("ends the window early, stops its server child and writes the summary, exit 0", async () => {
    const out = mkdtempSync(join(tmpdir(), "bots-interrupt-"));
    onTestFinished(() => rmSync(out, { recursive: true, force: true }));
    const cli = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/bots/cli.ts",
        "--count",
        "2",
        "--profile",
        "lan",
        "--minutes",
        "1",
        "--out",
        out,
      ],
      { cwd: fromRoot("packages", "tools"), detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    onTestFinished(() => {
      if (cli.exitCode === null && cli.pid !== undefined) process.kill(-cli.pid, "SIGKILL");
    });
    let stdout = "";
    let stderr = "";
    cli.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<number | null>((resolve) => cli.once("exit", resolve));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no window:\n${stdout}\n${stderr}`)), 30_000);
      cli.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes("measuring")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    process.kill(-(cli.pid as number), "SIGINT");
    const code = await exited;
    const detail = `${stdout}\n${stderr}`;
    expect(code, detail).toBe(0);
    expect(stderr, detail).toContain(
      "bots: interrupted; ending the window and writing the summary",
    );
    const wrote = /bots: wrote (\S+\.json) and (\S+\.md)/.exec(stdout);
    if (wrote === null) throw new Error(`no summary written:\n${detail}`);
    const summary = JSON.parse(readFileSync(wrote[1] as string, "utf8")) as BotsSummary;
    // The window ended early, and the child (spared the SIGINT) wrote its metrics at our SIGTERM.
    expect(
      summary.bots.every((b) => b.seconds < 10),
      detail,
    ).toBe(true);
    expect(summary.aggregate).toMatchObject({ joined: 2, closed: 0 });
    expect(summary.server, detail).toMatchObject({ source: "--metrics-out", players: 2 });
  }, 60_000);
});
