/** Startup log line; `monotonicMs` comes from a monotonic clock (performance.now). */
export function startupLine(monotonicMs: number): string {
  return `server ok t=${monotonicMs.toFixed(3)}ms`;
}
