import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDemo } from "@game/shared";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  expectStartsAndStops,
  listening,
  POSIX,
  pnpm,
  READY,
  repoRoot,
  serverDir,
  start,
  waitFor,
  within,
} from "../test/smokeRun";

// The server smoke test's long tier (D-032): the server from source stopped on SIGINT
// (`smoke.test.ts` stops it on SIGTERM in `pnpm test`), the acceptance command itself,
// `pnpm dev:server` from the repo root, stopped with its process group, and the bundle stopped
// while its stdout fails (D-051). Real processes on real time.

describe("server smoke test", () => {
  it("starts, logs JSON lines, answers /status, and stops cleanly on SIGINT", async () => {
    await expectStartsAndStops("SIGINT");
  }, 15_000);

  // The acceptance command itself, run the way a terminal's Ctrl+C or a process manager stops it.
  it.skipIf(!POSIX)(
    "`pnpm dev:server` from the repo root starts the server and stops with its process group",
    async () => {
      const [command, args] = pnpm(["dev:server", "--port", "0"]);
      const run = start(command, args, repoRoot, true);
      await waitFor(run, READY, 20_000, true);
      // pnpm hands the flags on to the server: it took a free port, not the default 28700.
      expect(listening(run).port).not.toBe(28700);
      run.kill("SIGTERM");
      await waitFor(run, /"ev":"shutdown"/, 5_000, false);
    },
    30_000,
  );

  // D-051: a stop may meet a console that is going away (closing a Windows console window
  // stops the server, SIGHUP there, while writes to it may fail). With our end of its stdout
  // destroyed, every log line it writes fails (EPIPE), and the stop must still end its demo,
  // write --metrics-out and exit 0, not end as an uncaught write error (exit 1, the demo cut).
  it("stops cleanly while its stdout fails: exit 0, a whole demo and the metrics file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "server-dead-stdout-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
    // The bundle outside the repository, run in `dir`: no `content/maps` above either, so its
    // demos go to `dir/demos`, not the repository's (`--maps` names the maps).
    const { type } = JSON.parse(readFileSync(join(serverDir, "package.json"), "utf8"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type }));
    const outfile = join(dir, "main.js");
    const build = spawnSync(process.execPath, ["build.mjs", outfile], {
      cwd: serverDir,
      encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);
    const metricsFile = join(dir, "metrics.json");
    const run = start(
      process.execPath,
      [
        outfile,
        "--port",
        "0",
        "--maps",
        join(repoRoot, "content", "maps"),
        "--metrics-out",
        metricsFile,
        "--set",
        "sv_autoRecord=1",
      ],
      dir,
    );
    await waitFor(run, READY, 10_000, true);
    const { buildHash } = listening(run);
    run.child.stdout?.destroy();
    run.child.stdin?.write("quit\n");
    const exit = await within(run.exited, 5_000, "no exit after quit");
    expect(exit).toEqual({ code: 0, signal: null });
    expect(JSON.parse(readFileSync(metricsFile, "utf8"))).toMatchObject({ buildHash });
    const demos = readdirSync(join(dir, "demos"));
    expect(demos).toEqual([expect.stringMatching(/^main-arena_greybox-\d{8}-\d{6}\.demo$/)]);
    const check = validateDemo(
      new Uint8Array(readFileSync(join(dir, "demos", demos[0] as string))),
    );
    expect(check.ok ? "valid" : check.error).toBe("valid");
  }, 30_000);
});
