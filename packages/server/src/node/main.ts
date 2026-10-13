import { setDevAsserts } from "@game/shared";
import { createJsonLog } from "./log";
import { type RunningServer, startServer } from "./server";
import { stopSignals } from "./signals";

/**
 * The dedicated server process (D-029): `pnpm dev:server` runs this from source, `pnpm build`
 * bundles it into `dist/main.js`. Log lines go to stdout as JSON; admin commands come on stdin.
 * SIGINT and SIGTERM (on Windows also SIGBREAK and SIGHUP) and the stdin command `quit` shut down
 * gracefully (exit 0; D-051), even when stdout fails during the stop. A bad config or map exits 1
 * with the reason.
 */
setDevAsserts(process.env.NODE_ENV !== "production");

const write = (line: string) => {
  process.stdout.write(`${line}\n`);
};
let server: RunningServer | null = null;
let stopSignal: string | null = null;

function stop(signal: string): void {
  if (stopSignal !== null) return;
  stopSignal = signal;
  // A stop's log lines may meet a console that is going away (its window closing on Windows,
  // D-051): a write that fails then must not end the shutdown (as an uncaught error, exit 1)
  // before every demo has its END record and --metrics-out is written, and nor may a late read
  // error once the console has stopped reading (it ends the console before that, console.ts).
  // Outside a stop a failed write still ends the process, so a child whose parent died without
  // stopping it ends too.
  process.stdout.on("error", () => {});
  process.stdin.on("error", () => {});
  // Before readiness the server is not up yet: it stops as soon as startServer returns.
  if (server !== null) void server.stop(signal).then(() => process.exit(0));
}

function fatal(e: unknown): never {
  createJsonLog(write)("error", "error", {
    msg: e instanceof Error ? e.message : String(e),
    ...(e instanceof Error && e.name !== "ConfigError" ? { stack: e.stack } : {}),
  });
  process.exit(1);
}

// Installed before the server starts, so whoever waits for a log line can stop it. A signal
// that comes while Node still loads the modules (before this line runs) ends the process with
// the default action, before anything was accepted.
for (const signal of stopSignals(process.platform)) process.on(signal, () => stop(signal));
// A bug that escapes a tick ends the process with a JSON error line (a supervisor restarts it).
process.on("uncaughtException", fatal);

try {
  // `pnpm dev:server` runs this from packages/server: the flags' relative paths resolve against
  // the directory the command was typed in (INIT_CWD, which pnpm sets), server.cfg's default
  // against packages/server.
  server = await startServer({
    args: process.argv.slice(2),
    write,
    console: process.stdin,
    argsCwd: process.env.INIT_CWD ?? process.cwd(),
    // The stdin `quit` (D-051): the stop every platform has, a parent's included (serverChild).
    onQuit: () => stop("quit"),
  });
  if (stopSignal !== null) await server.stop(stopSignal).then(() => process.exit(0));
} catch (e) {
  fatal(e);
}
