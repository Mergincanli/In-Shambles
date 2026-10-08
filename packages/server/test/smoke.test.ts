import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { computeBuildHash } from "../../../scripts/build-hash.mjs";
import { TestClient } from "./match/fixtures";
import { httpJson, NodeWsClient, until } from "./node/wsClient";

const serverDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
/** The JSON line the server logs once its port is bound (D-029). */
const READY = /"ev":"listening"/;
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

/** The JSON log lines in `output` with event `ev`. */
function events(output: string, ev: string): Record<string, unknown>[] {
  return output
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.ev === ev);
}

function listening(run: Run): { port: number; buildHash: string } {
  const line = events(run.output(), "listening")[0];
  return { port: line?.port as number, buildHash: line?.buildHash as string };
}

describe("server smoke test", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "starts, logs JSON lines, answers /status, and stops cleanly on %s",
    async (signal) => {
      const run = start(
        process.execPath,
        ["--import", "tsx", "src/node/main.ts", "--port", "0"],
        serverDir,
      );
      await waitFor(run, READY, 10_000, true);
      // Monotonic time since process start, not a wall-clock epoch timestamp.
      expect(events(run.output(), "server_ok")[0]?.startupMs).toBeLessThan(60_000);
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
    },
    15_000,
  );

  it("exits 1 with an error line on a bad setting", async () => {
    const run = start(
      process.execPath,
      ["--import", "tsx", "src/node/main.ts", "--port", "0", "--set", "sv_nope=1"],
      serverDir,
    );
    const exit = await within(run.exited, 10_000, "no exit on a bad setting");
    expect(exit).toEqual({ code: 1, signal: null });
    expect(events(run.output(), "error")[0]?.msg).toBe("--set: unknown cvar sv_nope");
  }, 15_000);

  it("the production bundle runs with plain node and serves a WebSocket client", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "server-bundle-"));
    onTestFinished(() => rmSync(outDir, { recursive: true, force: true, maxRetries: 5 }));
    // Run the bundle under the same module type as packages/server/dist/main.js, outside the
    // workspace, so it can't lean on node_modules: ws must be inside it.
    const { type } = JSON.parse(readFileSync(join(serverDir, "package.json"), "utf8"));
    writeFileSync(join(outDir, "package.json"), JSON.stringify({ type }));
    const outfile = join(outDir, "main.js");
    const build = spawnSync(process.execPath, ["build.mjs", outfile], {
      cwd: serverDir,
      encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);
    // ws's MIT notice travels with the bundle (content/LICENSES.md).
    expect(readFileSync(join(outDir, "third-party-licenses.md"), "utf8")).toContain("## ws (MIT)");

    const run = start(process.execPath, [outfile, "--port", "0"], serverDir);
    await waitFor(run, READY, 10_000, true);
    const { port, buildHash } = listening(run);
    // The hash of the checkout it was built from, baked in: run from a temp dir, the bundle could
    // not compute it.
    expect(buildHash).toBe(computeBuildHash());
    const ws = await NodeWsClient.connect(`ws://127.0.0.1:${port}/`);
    onTestFinished(() => ws.ws.close());
    const client = new TestClient(ws);
    client.hello(buildHash);
    await until(() => {
      client.poll();
      return client.welcomes.length === 1;
    }, "WELCOME");
    expect(client.welcomes[0]?.mapName).toBe("arena_greybox");
    // The bundle is strict about builds (sv_strictBuild 1, D-031): another one is KICKed with both.
    const stranger = await NodeWsClient.connect(`ws://127.0.0.1:${port}/`);
    onTestFinished(() => stranger.ws.close());
    const other = new TestClient(stranger);
    other.hello("someone-else");
    await until(() => {
      other.poll();
      return other.closed !== null;
    }, "the other build's kick");
    expect(other.kicks.map((k) => k.reason)).toEqual([
      `build someone-else does not match the server's ${buildHash}`,
    ]);

    run.kill("SIGTERM");
    const exit = await within(run.exited, 5_000, "no exit after SIGTERM");
    if (POSIX) {
      expect(exit).toEqual({ code: 0, signal: null });
      expect(events(run.output(), "shutdown")).toHaveLength(1);
      await until(() => {
        client.poll();
        return client.closed !== null;
      }, "the client's close");
      expect(client.kicks.map((k) => k.reason)).toEqual(["server shutting down"]);
    }
  }, 30_000);

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
});
