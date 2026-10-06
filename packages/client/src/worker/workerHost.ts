import type { LogLevel, LoopHost } from "@game/server";

/**
 * The match loop's environment inside the Worker (M2 design §2 "Match loop"): the monotonic
 * `performance.now`, one-shot `setTimeout` re-armed after every wake (never an interval), and
 * logs forwarded to the page. The Node host comes with the dedicated server in M3.
 */
export function createWorkerHost(log: (level: LogLevel, msg: string) => void): LoopHost {
  return {
    now: () => performance.now(),
    // setTimeout truncates to whole ms: round up, so a wake is never early by the fraction.
    schedule: (cb, ms) => {
      setTimeout(cb, Math.ceil(ms));
    },
    log,
  };
}
