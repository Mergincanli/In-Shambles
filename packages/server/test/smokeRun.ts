import { type ChildProcess, spawn } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished } from "vitest";
import { httpJson } from "./node/wsClient";

// The server smoke test's process helpers (D-029), shared by its two tiers (D-032):
// `smoke.test.ts` (start and stop on SIGTERM, a bad setting, the production bundle) and
// `packages/server/long/server-smoke.long.ts` (SIGINT, and `pnpm dev:server` from the repo root).

export const serverDir = fileURLToPath(new URL("..", import.meta.url));
export const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
/** The JSON line the server logs once its port is bound (D-029). */
export const READY = /"ev":"listening"/;
export const POSIX = process.platform !== "win32";

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface Run {
  child: ChildProcess;
  output(): string;
  exited: Promise<Exit>;
  /** Kill the process (or, for detached runs, its whole process group) if it's still around. */
  kill(signal: NodeJS.Signals): void;
}

/** Spawns a process and makes sure it's killed when the test ends, even on a timeout. */
export function start(command: string, args: string[], cwd: string, detached = false): Run {
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
export function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Resolves once `pattern` shows up in the output. Rejects on timeout, or on exit if `failOnExit`. */
export function waitFor(
  run: Run,
  pattern: RegExp,
  timeoutMs: number,
  failOnExit: boolean,
): Promise<void> {
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
export function pnpm(args: string[]): [string, string[]] {
  const execPath = process.env.npm_execpath ?? "";
  if (!basename(execPath).includes("pnpm")) return ["pnpm", args];
  return /\.[cm]?js$/.test(execPath) ? [process.execPath, [execPath, ...args]] : [execPath, args];
}

/** The JSON log lines in `output` with event `ev`. */
export function events(output: string, ev: string): Record<string, unknown>[] {
  return output
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.ev === ev);
}

export function listening(run: Run): { port: number; buildHash: string } {
  const line = events(run.output(), "listening")[0];
  return { port: line?.port as number, buildHash: line?.buildHash as string };
}

/**
 * The server from source starts, logs JSON lines, answers /status and runs a console line from
 * stdin, then stops cleanly on `signal`: exit 0 and one shutdown line naming it.
 */
export async function expectStartsAndStops(signal: NodeJS.Signals): Promise<void> {
  const run = start(
    process.execPath,
    ["--import", "tsx", "src/node/main.ts", "--port", "0"],
    serverDir,
  );
  await waitFor(run, READY, 10_000, true);
  // Monotonic time since process start, not a wall-clock epoch timestamp.
  const ok = events(run.output(), "server_ok")[0];
  expect(ok?.startupMs).toBeLessThan(60_000);
  // A fresh process runs the pmove primer once, within its startup (D-040).
  expect(ok?.primerMs).toBeGreaterThan(0);
  expect(ok?.primerMs).toBeLessThan(ok?.startupMs as number);
  const { port, buildHash } = listening(run);
  expect((await httpJson(port, "/status")).body).toMatchObject({ buildHash });
  // stdin is the admin console.
  run.child.stdin?.write("set pm_gravity 400\n");
  await waitFor(run, /"ev":"console"/, 5_000, true);
  expect(events(run.output(), "console")[0]).toMatchObject({ text: "pm_gravity = 400" });
  run.kill(signal);
  const exit = await within(run.exited, 5_000, `no exit after ${signal}`);
  // Windows can't deliver signals to a handler; there the process is just terminated.
  if (POSIX) {
    expect(exit).toEqual({ code: 0, signal: null });
    expect(events(run.output(), "shutdown")).toEqual([
      expect.objectContaining({ lvl: "info", signal }),
    ]);
  }
}
