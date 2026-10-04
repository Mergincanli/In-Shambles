/** Startup log line; `monotonicMs` comes from a monotonic clock (performance.now). */
export function startupLine(monotonicMs: number): string {
  return `server ok t=${monotonicMs.toFixed(3)}ms`;
}

export type StopSignal = "SIGINT" | "SIGTERM";

/** The process APIs the server uses, so tests can pass a fake. */
export interface ServerHost {
  onSignal(signal: StopSignal, handler: () => void): void;
  log(line: string): void;
  /** Monotonic milliseconds since process start. */
  now(): number;
  exit(code: number): void;
}

/**
 * Starts the placeholder server (the match loop arrives in M3). Shutdown handling is installed
 * before readiness is logged, so whoever waits for "server ok" can stop the server right away.
 * Returns a function that releases the keep-alive timer.
 */
export function startServer(host: ServerHost): () => void {
  // Stay alive like a real server until a stop signal arrives.
  const keepAlive = setInterval(() => {}, 2 ** 30);
  const release = () => clearInterval(keepAlive);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    host.onSignal(signal, () => {
      release();
      host.log(`server stopped (${signal})`);
      host.exit(0);
    });
  }
  host.log(startupLine(host.now()));
  return release;
}
