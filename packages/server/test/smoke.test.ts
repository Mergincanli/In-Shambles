import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const READY = /server ok t=(\d+\.\d{3})ms/;

interface Run {
  child: ChildProcess;
  output(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Kill the process (or, for detached runs, its whole process group) if it's still around. */
  kill(signal: NodeJS.Signals): void;
}

function start(command: string, args: string[], cwd: string, detached = false): Run {
  const child = spawn(command, args, { cwd, detached });
  let output = "";
  const append = (chunk: unknown) => {
    output += String(chunk);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return {
    child,
    output: () => output,
    exited,
    kill(signal) {
      if (child.pid === undefined) return;
      try {
        if (detached) process.kill(-child.pid, signal);
        else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      } catch {
        // Already gone.
      }
    },
  };
}

/** Resolves once `pattern` shows up in the output. Rejects on timeout, or on exit if `failOnExit`. */
function waitFor(run: Run, pattern: RegExp, timeoutMs: number, failOnExit: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error?: Error) => {
      clearTimeout(timer);
      run.child.stdout?.off("data", check);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (pattern.test(run.output())) done();
    };
    const timer = setTimeout(
      () => done(new Error(`no ${pattern} within ${timeoutMs} ms:\n${run.output()}`)),
      timeoutMs,
    );
    run.child.stdout?.on("data", check);
    if (failOnExit) {
      void run.exited.then(({ code, signal }) =>
        done(new Error(`exited early (code ${code}, signal ${signal}):\n${run.output()}`)),
      );
    }
    check();
  });
}

describe("server smoke test", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "starts, logs server ok, and stops cleanly on %s",
    async (signal) => {
      const run = start(process.execPath, ["--import", "tsx", "src/main.ts"], serverDir);
      try {
        await waitFor(run, READY, 10_000, true);
        // Monotonic time since process start, not a wall-clock epoch timestamp.
        expect(Number(READY.exec(run.output())?.[1])).toBeLessThan(60_000);
        run.kill(signal);
        // Windows can't deliver signals to a handler; there the process is just terminated.
        if (process.platform !== "win32") {
          expect(await run.exited).toEqual({ code: 0, signal: null });
          expect(run.output()).toContain(`server stopped (${signal})`);
        }
      } finally {
        run.kill("SIGKILL");
      }
    },
    15_000,
  );

  it("the production bundle runs with plain node", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "server-bundle-"));
    const outfile = join(outDir, "main.js");
    try {
      const build = spawnSync(process.execPath, ["build.mjs", outfile], {
        cwd: serverDir,
        encoding: "utf8",
      });
      expect(build.status, build.stderr).toBe(0);
      const run = start(process.execPath, [outfile], outDir);
      try {
        await waitFor(run, READY, 10_000, true);
        run.kill("SIGTERM");
        if (process.platform !== "win32") {
          expect(await run.exited).toEqual({ code: 0, signal: null });
        }
      } finally {
        run.kill("SIGKILL");
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);

  // The acceptance command itself, run the way a terminal's Ctrl+C or a process manager stops it.
  it.skipIf(process.platform === "win32")(
    "`pnpm dev:server` from the repo root starts the server and stops with its process group",
    async () => {
      const run = start("pnpm", ["dev:server"], repoRoot, true);
      try {
        await waitFor(run, READY, 20_000, true);
        run.kill("SIGTERM");
        await waitFor(run, /server stopped \(SIGTERM\)/, 5_000, false);
      } finally {
        run.kill("SIGKILL");
      }
    },
    30_000,
  );
});
