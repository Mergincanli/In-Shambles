import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

const serverDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const READY = /server ok t=(\d+\.\d{3})ms/;
const POSIX = process.platform !== "win32";

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

interface Run {
  child: ChildProcess;
  output(): string;
  exited: Promise<Exit>;
  /** Kill the process (or, for detached runs, its whole process group) if it's still around. */
  kill(signal: NodeJS.Signals): void;
}

/** Spawns a process and makes sure it's killed when the test ends, even on a timeout. */
function start(command: string, args: string[], cwd: string, detached = false): Run {
  const child = spawn(command, args, { cwd, detached });
  let output = "";
  const append = (chunk: unknown) => {
    output += String(chunk);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    // A failed spawn (e.g. pnpm not on PATH) emits "error" and no "exit".
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
  });
  const run: Run = {
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
  onTestFinished(() => run.kill("SIGKILL"));
  return run;
}

/** Rejects with `what` if `promise` takes longer than `ms`, well inside the test timeout. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
      void run.exited.then(({ code, signal, error }) =>
        done(
          new Error(
            `${error ? `failed to start: ${error.message}` : `exited early (code ${code}, signal ${signal})`}:\n${run.output()}`,
          ),
        ),
      );
    }
    check();
  });
}

/** pnpm the way the test run was started (pnpm sets npm_execpath), else from PATH. */
function pnpm(args: string[]): [string, string[]] {
  const execPath = process.env.npm_execpath ?? "";
  if (!basename(execPath).includes("pnpm")) return ["pnpm", args];
  return /\.[cm]?js$/.test(execPath) ? [process.execPath, [execPath, ...args]] : [execPath, args];
}

describe("server smoke test", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "starts, logs server ok, and stops cleanly on %s",
    async (signal) => {
      const run = start(process.execPath, ["--import", "tsx", "src/main.ts"], serverDir);
      await waitFor(run, READY, 10_000, true);
      // Monotonic time since process start, not a wall-clock epoch timestamp.
      expect(Number(READY.exec(run.output())?.[1])).toBeLessThan(60_000);
      run.kill(signal);
      const exit = await within(run.exited, 5_000, `no exit after ${signal}`);
      // Windows can't deliver signals to a handler; there the process is just terminated.
      if (POSIX) {
        expect(exit).toEqual({ code: 0, signal: null });
        expect(run.output()).toContain(`server stopped (${signal})`);
      }
    },
    15_000,
  );

  it("the production bundle runs with plain node", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "server-bundle-"));
    onTestFinished(() => rmSync(outDir, { recursive: true, force: true, maxRetries: 5 }));
    // Run the bundle under the same module type as packages/server/dist/main.js.
    const { type } = JSON.parse(readFileSync(join(serverDir, "package.json"), "utf8"));
    writeFileSync(join(outDir, "package.json"), JSON.stringify({ type }));
    const outfile = join(outDir, "main.js");
    const build = spawnSync(process.execPath, ["build.mjs", outfile], {
      cwd: serverDir,
      encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);

    const run = start(process.execPath, [outfile], serverDir);
    await waitFor(run, READY, 10_000, true);
    run.kill("SIGTERM");
    const exit = await within(run.exited, 5_000, "no exit after SIGTERM");
    if (POSIX) expect(exit).toEqual({ code: 0, signal: null });
  }, 30_000);

  // The acceptance command itself, run the way a terminal's Ctrl+C or a process manager stops it.
  it.skipIf(!POSIX)(
    "`pnpm dev:server` from the repo root starts the server and stops with its process group",
    async () => {
      const [command, args] = pnpm(["dev:server"]);
      const run = start(command, args, repoRoot, true);
      await waitFor(run, READY, 20_000, true);
      run.kill("SIGTERM");
      await waitFor(run, /server stopped \(SIGTERM\)/, 5_000, false);
    },
    30_000,
  );
});
