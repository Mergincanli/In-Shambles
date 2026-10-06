/**
 * What a match loop needs from its environment (M2 design §2 "Match loop", D-027). The match code
 * runs unchanged in a Web Worker (the offline server) and in Node (the dedicated server, M3), so
 * the clock, the timer and the log come in through this interface instead of `performance`,
 * `setTimeout` or `console` (docs/06 §4: small adapters for clock, logging and transport).
 */
export type LogLevel = "info" | "warn" | "error";

export interface LoopHost {
  /** Monotonic milliseconds (fractional allowed); never a wall clock. */
  now(): number;
  /**
   * Calls `cb` once, about `ms` milliseconds from now (`ms` is fractional and >= 0). Early or late
   * calls are fine. A timer that truncates to whole milliseconds (`setTimeout`) should be given
   * `Math.ceil(ms)`: an early wake runs nothing and costs a second, short timer.
   */
  schedule(cb: () => void, ms: number): void;
  log(level: LogLevel, msg: string): void;
}

/** The log half of a host, for code that has no clock (the match itself). */
export type MatchLog = (level: LogLevel, msg: string) => void;
