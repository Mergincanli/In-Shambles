import { HITCH_FRAME_MS, StrafeCircuit, TICK_MS } from "@game/client/net";
import type { NetProfile } from "@game/shared";
import {
  FRAMES_144HZ,
  FRAMES_BROWSER_HITCHES,
  type FrameLog,
  type FrameModel,
  NetHarness,
} from "./harness";
import { expectNoStrikes } from "./honest";

// NET-07's runs and checks (docs/05 §14, M3 design §2.7 and §5, D-039), shared by its two tiers
// (D-032): `net-07-time-dilation.test.ts` runs seed 1 at 144 Hz both ways and the dilation-off
// control in `pnpm test`; `packages/tools/long/net-07-time-dilation.long.ts` runs seeds 2–3, the
// browser-hitch frames and the rest of the control in `pnpm test:long`.

/**
 * The two links of the round-trip step: one-way 25 and 75 ms (RTT 50 → 150 ms, docs/05 §14),
 * jitter as `wan-50`'s, no loss, so the step is the only thing the clock has to answer.
 */
export const NEAR: NetProfile = Object.freeze({
  name: "one-way-25",
  delayMs: 25,
  jitterMs: 3,
  loss: 0,
  duplicate: 0,
  reorder: 0,
});
export const FAR: NetProfile = Object.freeze({ ...NEAR, name: "one-way-75", delayMs: 75 });

/**
 * The spec's largest dilation (docs/05 §8.2), written out rather than imported from the clock, so
 * a wider `DIL_MAX` fails here instead of widening the test with it.
 */
export const SPEC_DIL_MAX = 0.03;
/**
 * Ticks predicted past the startup fill before the step: 1.5 s idle, then 8.5 s of circuit, so the
 * clock's windows and EWMA have settled on the first link (and the mean the up-step rule compares
 * with is the settled one).
 */
export const BEFORE_TICKS = 600;
/** The window the step is judged over (M3 design §2.7's re-converged metric), ms. */
export const WINDOW_MS = 6000;
/** Re-converged within this after the step: up (spec, docs/05 §14) and down (design), ms. */
export const UP_BOUND_MS = 2000;
export const DOWN_BOUND_MS = 4000;
/** The metric holds for at least this long, to the end of the window, ms. */
const HOLD_MS = 1000;
/** Ticks per wall second are judged over windows this long, outside step frames, ms. */
const RATE_WINDOW_MS = 500;
/** The 144 Hz up-step speeds up for at least this long without a break, ms. */
const SPEED_UP_MS = 300;
/**
 * … and over the bound's last this-many ms its mean stays within target ± 0.5, read as the
 * re-converged metric reads it (D-039): [target − 0.5, target + 0.5 + spread], since the lead's
 * sub-tick phase settles a steady mean anywhere in [target, target + 1). A clock that leaves the
 * mean a tick short (a fast-forward alone) or overshoots fails.
 */
const BOUND_TAIL_MS = 500;
/**
 * Corrections a step may cost before the bound (D-039's reading of "corrections < 1/s"): the
 * up-step starves the server until its fast-forward lands, about 0.25 s (the 6-snapshot run plus
 * the new round trip), so up to about 15 cmds at 60 Hz, each a correction at strafe speed. After
 * the bound the rate is judged as such.
 */
const STEP_CORRECTIONS_MAX = 20;

export const FRAME_MODELS = {
  "144 Hz": FRAMES_144HZ,
  "browser hitches": FRAMES_BROWSER_HITCHES,
} as const satisfies Record<string, FrameModel>;
export type FrameModelName = keyof typeof FRAME_MODELS;

export interface StepRun {
  readonly h: NetHarness;
  readonly up: boolean;
  /** Harness time of the step, ms, and the first frame at or after it. */
  readonly stepMs: number;
  readonly stepFrame: number;
  /** Fast-forwards, holds, hard resyncs and corrections before the step, and corrections by the bound. */
  readonly ffBefore: number;
  readonly holdsBefore: number;
  readonly resyncsBefore: number;
  readonly correctionsBefore: number;
  readonly correctionsAtBound: number;
}

/** The strafe-jump circuit on NEAR (up) or FAR, stepped to the other link mid-circuit. */
export function runStep(
  up: boolean,
  seed: number,
  frames: FrameModelName,
  dilation = true,
): StepRun {
  const h = new NetHarness({
    input: new StrafeCircuit(),
    profile: up ? NEAR : FAR,
    seed,
    frameIntervalMs: FRAME_MODELS[frames],
    dilation,
  });
  h.runTicks(BEFORE_TICKS);
  const stepMs = h.now;
  const stepFrame = h.frames.time.length;
  const ffBefore = h.client.clock.fastForwards;
  const holdsBefore = h.client.clock.holds;
  const before = h.totals();
  h.sim?.setProfile(up ? FAR : NEAR);
  const bound = up ? UP_BOUND_MS : DOWN_BOUND_MS;
  h.run(bound);
  const correctionsAtBound = h.totals().corrections;
  h.run(WINDOW_MS - bound);
  expectNoStrikes(h.match, [h.client]);
  return {
    h,
    up,
    stepMs,
    stepFrame,
    ffBefore,
    holdsBefore,
    resyncsBefore: before.hardResyncs,
    correctionsBefore: before.corrections,
    correctionsAtBound,
  };
}

export interface StepReport {
  /** ms from the step until re-converged (Infinity: never, within the window). */
  readonly reconvergedMs: number;
  /** The spread the M bound allows for: the low edge's distance to the mean, ticks. */
  readonly spread: number;
  readonly maxAbsDilation: number;
  /** The extreme ticks per wall second over the 0.5 s windows outside step frames. */
  readonly minRate: number;
  readonly maxRate: number;
  /** Since the step. */
  readonly fastForwards: number;
  readonly holds: number;
  readonly hardResyncs: number;
  /** Corrections from the step to the end of the window, and their rate after the bound (1/s). */
  readonly corrections: number;
  readonly lateCorrectionsPerSecond: number;
  /**
   * How far the mean strays outside [target − 0.5, target + 0.5 + spread] over the bound's last
   * BOUND_TAIL_MS at most (ticks; 0: it stays inside).
   */
  readonly boundMeanOut: number;
  /** The longest unbroken run of δ > 0 within the window, ms. */
  readonly longestSpeedUpMs: number;
  /** Sign changes of δ (zeros skipped) from re-converged to the end of the window. */
  readonly signChanges: number;
}

/**
 * The step's numbers (M3 design §2.7, §5). Re-converged is the first time after which, for at
 * least 1 s and to the end of the window, every 30-snapshot low edge is at target − 1 or above and
 * the mean within [target − 0.5, target + 0.5 + spread]. The spread is the frame rhythm's: the
 * largest distance from the low edge to the mean the clock showed in the 3 s before the step or in
 * the window's last second (with steady frames on this link, well under a tick; with hitches,
 * their bursts' several ticks).
 */
export function report(r: StepRun): StepReport {
  const h = r.h;
  const f = h.frames;
  const target = h.client.settings.inputBuffer;
  const bound = r.up ? UP_BOUND_MS : DOWN_BOUND_MS;
  const end = r.stepMs + WINDOW_MS;
  let spread = 0;
  for (let i = 0; i < f.time.length; i++) {
    const t = f.time[i] as number;
    const steady = (t >= r.stepMs - 3000 && t < r.stepMs) || t >= end - 1000;
    if (steady) spread = Math.max(spread, (f.buffer[i] as number) - (f.bufferLow[i] as number));
  }
  let lastBad = -1;
  let last = r.stepFrame;
  for (let i = r.stepFrame; i < f.time.length && (f.time[i] as number) <= end; i++) {
    last = i;
    const m = f.buffer[i] as number;
    const ok =
      (f.bufferLowFast[i] as number) >= target - 1 &&
      m >= target - 0.5 &&
      m <= target + 0.5 + spread;
    if (!ok) lastBad = i;
  }
  const tc = lastBad < 0 ? r.stepMs : lastBad >= last ? Infinity : (f.time[lastBad + 1] as number);
  const reconvergedMs = end - tc >= HOLD_MS ? tc - r.stepMs : Infinity;
  let maxAbsDilation = 0;
  for (const d of f.dilation) maxAbsDilation = Math.max(maxAbsDilation, Math.abs(d));
  const rates = rateRange(f);
  let boundMeanOut = 0;
  let longestSpeedUpMs = 0;
  let runFrom = -1;
  for (let i = r.stepFrame; i < f.time.length; i++) {
    const t = f.time[i] as number;
    if (t >= r.stepMs + bound - BOUND_TAIL_MS && t <= r.stepMs + bound) {
      const m = f.buffer[i] as number;
      boundMeanOut = Math.max(boundMeanOut, target - 0.5 - m, m - (target + 0.5 + spread));
    }
    if ((f.dilation[i] as number) > 0) {
      if (runFrom < 0) runFrom = t;
      longestSpeedUpMs = Math.max(longestSpeedUpMs, t - runFrom);
    } else {
      runFrom = -1;
    }
  }
  let signChanges = 0;
  let sign = 0;
  for (let i = r.stepFrame; i < f.time.length; i++) {
    if ((f.time[i] as number) < tc) continue;
    const s = Math.sign(f.dilation[i] as number);
    if (s === 0) continue;
    if (sign !== 0 && s !== sign) signChanges++;
    sign = s;
  }
  const t = h.totals();
  const clock = h.client.clock;
  return {
    reconvergedMs,
    spread,
    maxAbsDilation,
    minRate: rates[0],
    maxRate: rates[1],
    fastForwards: clock.fastForwards - r.ffBefore,
    holds: clock.holds - r.holdsBefore,
    hardResyncs: t.hardResyncs - r.resyncsBefore,
    corrections: t.corrections - r.correctionsBefore,
    lateCorrectionsPerSecond: (t.corrections - r.correctionsAtBound) / ((WINDOW_MS - bound) / 1000),
    boundMeanOut,
    longestSpeedUpMs,
    signChanges,
  };
}

/**
 * The lowest and highest ticks per wall second (the predicted path's advance, `pathTicks`, over
 * the elapsed ticks) across 0.5 s windows of frames, leaving out every window with a step or
 * re-anchor frame in it (a nonzero `pathShift`) and the frames before the first anchor.
 */
export function rateRange(f: FrameLog): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  let a = 0;
  while (a < f.time.length && !Number.isFinite(f.pathTicks[a] as number)) a++;
  let lastShift = -1;
  for (let b = a; b < f.time.length; b++) {
    if ((f.pathShift[b] as number) !== 0) lastShift = b;
    while ((f.time[b] as number) - (f.time[a + 1] as number) >= RATE_WINDOW_MS) a++;
    const span = (f.time[b] as number) - (f.time[a] as number);
    if (span < RATE_WINDOW_MS || lastShift > a) continue;
    const rate = ((f.pathTicks[b] as number) - (f.pathTicks[a] as number)) / (span / TICK_MS);
    lo = Math.min(lo, rate);
    hi = Math.max(hi, rate);
  }
  return [lo, hi];
}

/** The NET-07 criteria `rep` misses (M3 design §5), by name; empty when it passes. */
export function failures(rep: StepReport, up: boolean, frames: FrameModelName): string[] {
  const out: string[] = [];
  if (!(rep.reconvergedMs <= (up ? UP_BOUND_MS : DOWN_BOUND_MS))) out.push("re-converged");
  if (rep.maxAbsDilation > SPEC_DIL_MAX + 1e-12) out.push("|δ| cap");
  if (rep.minRate < 1 - SPEC_DIL_MAX - 1e-9 || rep.maxRate > 1 + SPEC_DIL_MAX + 1e-9)
    out.push("rate");
  if (rep.fastForwards > 2) out.push("fast-forwards");
  if (rep.holds > 0) out.push("holds");
  if (rep.hardResyncs > 0) out.push("hard resyncs");
  if (rep.corrections > STEP_CORRECTIONS_MAX || rep.lateCorrectionsPerSecond >= 1)
    out.push("corrections");
  if (frames === "144 Hz" && up && (rep.boundMeanOut > 0 || rep.longestSpeedUpMs < SPEED_UP_MS))
    out.push("144 Hz up-step");
  if (rep.signChanges > 2) out.push("sign changes");
  return out;
}

/**
 * The ticks dilation added over the logged frames, stall frames (over HITCH_FRAME_MS) left out:
 * each frame's time × the δ the frame before left (what `STAT_DILATION` should sum to).
 */
export function dilationTicks(f: FrameLog): number {
  let sum = 0;
  for (let i = 1; i < f.time.length; i++) {
    const dt = (f.time[i] as number) - (f.time[i - 1] as number);
    if (dt <= HITCH_FRAME_MS) sum += (dt * (f.dilation[i - 1] as number)) / TICK_MS;
  }
  return sum;
}

/** One line for the log. */
export function describeStep(name: string, rep: StepReport): string {
  return (
    `NET-07 ${name}: re-converged ${Number.isFinite(rep.reconvergedMs) ? `${rep.reconvergedMs.toFixed(0)} ms` : "never"} ` +
    `(spread ${rep.spread.toFixed(2)}), |δ| max ${rep.maxAbsDilation.toFixed(3)}, ` +
    `rate ${rep.minRate.toFixed(4)}–${rep.maxRate.toFixed(4)}, ${rep.fastForwards} fast-forwards, ` +
    `${rep.holds} holds, ${rep.hardResyncs} hard resyncs, ${rep.corrections} corrections ` +
    `(${rep.lateCorrectionsPerSecond.toFixed(2)}/s after the bound), ` +
    `mean at the bound ${rep.boundMeanOut.toFixed(2)} out of its band, ` +
    `speed-up ${rep.longestSpeedUpMs.toFixed(0)} ms, ${rep.signChanges} sign changes`
  );
}
