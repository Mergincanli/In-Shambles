import { setDevAsserts } from "@game/shared";
import { createJsonLog } from "./log";
import { type RunningServer, startServer } from "./server";

/**
 * The dedicated server process (D-029): `pnpm dev:server` runs this from source, `pnpm build`
 * bundles it into `dist/main.js`. Log lines go to stdout as JSON; admin commands come on stdin.
 * SIGINT and SIGTERM shut down gracefully (exit 0). A bad config or map exits 1 with the reason.
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
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
// A bug that escapes a tick ends the process with a JSON error line (a supervisor restarts it).
process.on("uncaughtException", fatal);

try {
  server = await startServer({ args: process.argv.slice(2), write, console: process.stdin });
  if (stopSignal !== null) await server.stop(stopSignal).then(() => process.exit(0));
} catch (e) {
  fatal(e);
}
