import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fromRoot } from "../paths";

/**
 * The server a bots run starts when no `--server` is given (M3 design §2.15, D-036): the built
 * bundle (`packages/server/dist/main.js`) if there is one newer than its sources, else the source
 * under tsx (`pnpm build` first to measure the bundle), on a free
 * port, with the metrics file and its discarded start. The match's default `sv_maxClients` (32)
 * covers 16 bots + 1 human; only a larger run raises it, to count + 2 (at most 64).
 */

/** The server's default `sv_maxClients` (D-034), which a bots run leaves alone up to 30 bots. */
export const SERVER_DEFAULT_MAX_CLIENTS = 32;
/** Players a match holds at most (`MATCH_MAX_CLIENTS`, D-034). */
const MAX_CLIENTS = 64;
/** How long the child may take to log `listening` (it loads a map and primes nothing yet). */
const LISTEN_TIMEOUT_MS = 30_000;
/** How long the child may take to exit after SIGTERM before it is killed. */
const EXIT_TIMEOUT_MS = 5_000;

export const SERVER_BUNDLE = fromRoot("packages", "server", "dist", "main.js");
const SERVER_DIR = fromRoot("packages", "server");

/**
 * The child's flags: a free port, the map, the metrics file and the seconds discarded before the
 * run window, and `sv_maxClients` only when `count` bots plus room for a human and one more
 * (count + 2) would not fit the default.
 */
export function serverChildArgs(
  count: number,
  map: string,
  metricsOut: string,
  discardS: number,
): string[] {
  const args = [
    "--port",
    "0",
    "--map",
    map,
    "--metrics-out",
    metricsOut,
    "--metrics-discard",
    String(discardS),
  ];
  if (count + 2 > SERVER_DEFAULT_MAX_CLIENTS) {
    args.push("--set", `sv_maxClients=${Math.min(MAX_CLIENTS, count + 2)}`);
  }
  return args;
}

export interface ServerChild {
  readonly child: ChildProcess;
  /** "dist" (the bundle) or "tsx" (the source: no bundle, or one older than the source). */
  readonly kind: "dist" | "tsx";
  readonly port: number;
  readonly buildHash: string;
  /** The child's JSON log lines so far, parsed. */
  readonly lines: Record<string, unknown>[];
  /** Whether it exited (or failed to run) without `stop`, e.g. a crash mid-run. */
  readonly died: () => boolean;
  /** SIGTERM, then the exit code (SIGKILL after EXIT_TIMEOUT_MS). Idempotent. */
  stop(): Promise<number | null>;
}

/** The newest modification time (ms) of any file under `dir`. */
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const st = statSync(join(dir, entry));
    if (st.isFile()) newest = Math.max(newest, st.mtimeMs);
  }
  return newest;
}

/**
 * Whether the bundle is there and newer than the code it is built from (the server's and the
 * shared package's sources and the build script): a stale bundle would run yesterday's server
 * without flags this run needs, so the source runs instead.
 */
export function bundleIsFresh(): boolean {
  if (!existsSync(SERVER_BUNDLE)) return false;
  const built = statSync(SERVER_BUNDLE).mtimeMs;
  const sources = Math.max(
    newestMtime(join(SERVER_DIR, "src")),
    newestMtime(fromRoot("packages", "shared", "src")),
    statSync(join(SERVER_DIR, "build.mjs")).mtimeMs,
  );
  return built >= sources;
}

/**
 * Starts the server child and resolves once it logs `listening` (its port and build hash). The
 * child gets its own process group (`detached`), so a terminal's Ctrl+C reaches only the bots,
 * which end their window, write the summary and stop the child themselves; a runner that exits
 * any other way still SIGTERMs it on the way out.
 */
export function startServerChild(args: readonly string[]): Promise<ServerChild> {
  const kind = bundleIsFresh() ? "dist" : "tsx";
  const argv =
    kind === "dist"
      ? [SERVER_BUNDLE, ...args]
      : ["--import", "tsx", fromRoot("packages", "server", "src", "node", "main.ts"), ...args];
  const child = spawn(process.execPath, argv, {
    cwd: SERVER_DIR,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const lines: Record<string, unknown>[] = [];
  let stderr = "";
  let partial = "";
  let done = false;
  const onExit = () => {
    if (!done) child.kill("SIGTERM");
  };
  process.once("exit", onExit);
  const exited = new Promise<number | null>((resolve) => {
    const end = (code: number | null) => {
      done = true;
      process.off("exit", onExit);
      resolve(code);
    };
    child.once("exit", (code) => end(code));
    child.once("error", () => end(null));
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let stopping: Promise<number | null> | null = null;
  const stop = (): Promise<number | null> => {
    if (stopping !== null) return stopping;
    if (!done) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), EXIT_TIMEOUT_MS);
    stopping = exited.finally(() => clearTimeout(timer));
    return stopping;
  };
  const died = () => done && stopping === null;
  return new Promise((resolve, reject) => {
    let listening = false;
    const fail = (why: string) => {
      // After `listening`, an exit is the run's to report (`died`), not a failed start.
      if (listening) return;
      clearTimeout(timer);
      void stop();
      reject(new Error(`server child (${kind}): ${why}${stderr === "" ? "" : `\n${stderr}`}`));
    };
    const timer = setTimeout(() => fail("no listening line"), LISTEN_TIMEOUT_MS);
    void exited.then((code) => fail(`exited with code ${code} before listening`));
    child.stdout?.on("data", (chunk) => {
      partial += String(chunk);
      const parts = partial.split("\n");
      partial = parts.pop() ?? "";
      for (const text of parts) {
        if (!text.startsWith("{")) continue;
        let line: Record<string, unknown>;
        try {
          line = JSON.parse(text) as Record<string, unknown>;
        } catch {
          continue;
        }
        lines.push(line);
        if (line.ev === "error") fail(String(line.msg));
        if (line.ev === "listening" && !listening) {
          clearTimeout(timer);
          listening = true;
          resolve({
            child,
            kind,
            port: line.port as number,
            buildHash: line.buildHash as string,
            lines,
            died,
            stop,
          });
        }
      }
    });
  });
}
