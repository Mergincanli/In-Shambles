/**
 * Simulation time is an integer tick count (D-004). Tick counters stay below 2^30 (about 207
 * days at 60 Hz) so V8 keeps them as small integers.
 */
export const TICK_RATE = 60;

/** The largest tick the sim accepts: 2^30 − 1. */
export const TICK_MAX = 0x3fffffff;

/** The one dt constant: every sim step uses this value, never a measured frame time. */
export const TICK_DT = 1 / TICK_RATE;

/**
 * Nearest whole tick for a duration in seconds (setup-time: cvars, content data). The `+ 0`
 * turns the −0 Math.round gives for tiny negative durations into +0.
 */
export function secondsToTicks(seconds: number): number {
  return Math.round(seconds * TICK_RATE) + 0;
}

/** Nearest whole tick for a duration in milliseconds; never −0. */
export function msToTicks(ms: number): number {
  return Math.round((ms * TICK_RATE) / 1000) + 0;
}

/** Milliseconds covered by `ticks` (display and timers; not rounded). */
export function ticksToMs(ticks: number): number {
  return (ticks * 1000) / TICK_RATE;
}
