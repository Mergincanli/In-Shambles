import { MAX_ADAPTIVE_TICKS, StrafeCircuit } from "@game/client/net";
import { findNetProfile, type NetProfile } from "@game/shared";
import { expect } from "vitest";
import {
  FRAMES_BROWSER_HITCHES,
  FRAMES_SLOW_HOST,
  FRAMES_SLOWER_HOST,
  type FrameLog,
  type FrameModel,
  NetHarness,
} from "./harness";

// NET-04's runs, checks and case lists (the M2 basic version; docs/05 §14, M2 design §5), shared
// by its two tiers (D-032): `net-04-reconciliation.test.ts` runs one seed per profile and one
// browser-like frame model case in `pnpm test`; `packages/tools/long/net-04-reconciliation.long.ts`
// runs the other seeds, the other browser-like cases and the onset runs in `pnpm test:long`. Both
// files' headers say what the runs check.

/** The circuit stands still this long first (StrafeCircuit's default), then strafe-jumps 60 s. */
export const IDLE_TICKS = 90;
export const TICKS = 3600;
export const SECONDS = TICKS / 60;
/**
 * NetSim seeds. The lossy WAN profiles run three: corrections are rare there (0 to about 12 a
 * minute, all under a unit), and seeds 5 and 7 have some, so the smoothing path is exercised too.
 */
export const SEED = 1;
export const LOSSY_SEEDS = [1, 5, 7];

/**
 * The largest frame-to-frame step of the drawn position over its allowance (≤ 1 passes), from
 * `fromMs` (harness time) on.
 */
export function worstStep(f: FrameLog, fromMs = 0): number {
  let worst = 0;
  for (let i = 1; i < f.time.length; i++) {
    if ((f.time[i] as number) < fromMs) continue;
    const step = Math.hypot(
      (f.x[i] as number) - (f.x[i - 1] as number),
      (f.y[i] as number) - (f.y[i - 1] as number),
      (f.z[i] as number) - (f.z[i - 1] as number),
    );
    const speed = Math.max(f.speed[i] as number, f.speed[i - 1] as number);
    const dt = ((f.time[i] as number) - (f.time[i - 1] as number)) / 1000;
    worst = Math.max(worst, step / (speed * dt * 1.5 + 0.5));
  }
  return worst;
}

/** Server ticks that repeated a cmd once the circuit was moving. */
export function starvedMoving(h: NetHarness, idleTicks: number): number {
  const moving = h.client.startTick + idleTicks;
  return h.serverStarved.filter((tick) => tick > moving).length;
}

/** The mean of the clock's buffer health over the frames from `from` on, ticks. */
export function bufferMean(f: FrameLog, from = 0): number {
  let sum = 0;
  for (let i = from; i < f.buffer.length; i++) sum += f.buffer[i] as number;
  return sum / Math.max(1, f.buffer.length - from);
}

export function run(
  profile: NetProfile,
  seed = SEED,
  frames?: { name: string; model: FrameModel },
  idleTicks = IDLE_TICKS,
): NetHarness {
  const h = new NetHarness({
    input: new StrafeCircuit({ idleTicks }),
    profile,
    seed,
    frameIntervalMs: frames?.model,
  });
  h.runTicks(idleTicks + TICKS);
  const t = h.totals();
  const maxOffset = Math.max(...h.frames.offset);
  const maxSpeed = Math.max(...h.frames.speed);
  const clock = h.client.clock;
  console.log(
    `NET-04 ${profile.name.padEnd(13)} ${frames === undefined ? "" : `${frames.name} `}seed ${seed}: ` +
      `rtt ${clock.rttMs.toFixed(0).padStart(3)} ms, ` +
      `buffer ${clock.bufferHealth.toFixed(2)} (mean ${bufferMean(h.frames).toFixed(2)}, ` +
      `low ${clock.bufferLow}, +${clock.adaptiveTicks}) ticks, ` +
      `${t.corrections} corrections (${(t.corrections / SECONDS).toFixed(2)}/s, ` +
      `mean ${t.meanCorrection.toFixed(2)} u, max ${t.maxCorrection.toFixed(2)} u), ` +
      `render offset max ${maxOffset.toFixed(2)} u, worst step ${worstStep(h.frames).toFixed(2)}, ` +
      `${t.starved} starved (${starvedMoving(h, idleTicks)} moving), ` +
      `${t.clockAdjustments} clock steps, top speed ${maxSpeed.toFixed(0)} u/s`,
  );
  return h;
}

/** The circuit ran: the player stayed on the floor and strafe-jumped past the run cap. */
export function expectCircuit(h: NetHarness): void {
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const s of h.server.values()) {
    minZ = Math.min(minZ, s.origin[2] as number);
    maxZ = Math.max(maxZ, s.origin[2] as number);
  }
  expect(minZ).toBeGreaterThan(0);
  expect(maxZ).toBeLessThan(100);
  expect(Math.max(...h.frames.speed)).toBeGreaterThan(500);
}

/**
 * Every snapshot the client reconciled with left its prediction equal to the server's state. It
 * reconciles once a frame, so at least `minReconciles` of them (half the ticks at 144 Hz).
 */
export function expectConverged(h: NetHarness, minReconciles = TICKS / 2): void {
  expect(h.snapshotTicks.length).toBeGreaterThan(minReconciles);
  expect(h.unreconciled()).toEqual([]);
}

export const profile = (name: string) => findNetProfile(name) as NetProfile;

/** Frame models of the browser-like block (the harness's seeded draws). */
export const FRAME_MODELS = [
  { name: "browser hitches", model: FRAMES_BROWSER_HITCHES },
  { name: "slow host", model: FRAMES_SLOW_HOST },
  { name: "slower host", model: FRAMES_SLOWER_HOST },
];
/**
 * Bounded latency: the buffer's mean health over the run stays under target + 5 ticks. The frame
 * rhythm costs its spread (3.4 to 5.9 ticks of mean on these seeds, up to 6.4 over seeds 1–10),
 * so a buffer grown to its cap (target + 8) or left large after a round trip fell fails.
 */
export const BUFFER_MEAN_ABOVE_TARGET = 5;
/** Frames turn bad this long into the onset runs (the circuit is moving by then). */
export const ONSET_MS = 15_000;
/**
 * The clock has learned a new frame rhythm this long after it set in: three dips in its window
 * (with 60 fps hitches about 0.3 s, at worst about 1.4 s over seeds 1–4).
 */
export const LEARN_MS = 2000;

/**
 * The render offset split by its cause, from `fromMs` (harness time) on: within
 * cl_correctionSmoothMs of a clock step or a hard resync it is that step's glide (a fast-forward's
 * skip, a hold's slowdown, a re-anchor; the offset decays linearly over that time), otherwise a
 * correction's. Also the steps and resyncs taken while moving (over 100 u/s), and the first one.
 */
export function offsetsByCause(
  h: NetHarness,
  fromMs = 0,
): { glide: number; correction: number; stepsMoving: number; firstStepMs: number } {
  const f = h.frames;
  const smoothMs = h.client.settings.correctionSmoothMs;
  let lastStep = Number.NEGATIVE_INFINITY;
  let glide = 0;
  let correction = 0;
  let stepsMoving = 0;
  let firstStepMs = Number.POSITIVE_INFINITY;
  for (let i = 1; i < f.time.length; i++) {
    const time = f.time[i] as number;
    const stepped =
      (f.clockSteps[i] as number) > (f.clockSteps[i - 1] as number) ||
      (f.hardResyncs[i] as number) > (f.hardResyncs[i - 1] as number);
    if (stepped) lastStep = time;
    if (time < fromMs) continue;
    if (stepped && firstStepMs === Number.POSITIVE_INFINITY) firstStepMs = time;
    if (stepped && (f.speed[i] as number) > 100) stepsMoving++;
    const o = f.offset[i] as number;
    if (time - lastStep <= smoothMs) glide = Math.max(glide, o);
    else correction = Math.max(correction, o);
  }
  return { glide, correction, stepsMoving, firstStepMs };
}

/** Bounds every browser-like run shares: the clock's steps glide, nothing rubber-bands. */
export function expectGlidesOnly(h: NetHarness, fromMs = 0): void {
  const o = offsetsByCause(h, fromMs);
  console.log(
    `  offsets from ${(fromMs / 1000).toFixed(1)} s: correction max ${o.correction.toFixed(2)} u, ` +
      `glide max ${o.glide.toFixed(2)} u, ${o.stepsMoving} steps or resyncs while moving`,
  );
  // A correction's offset stays under NET-04's 8 u; a step's is a forward glide over
  // cl_correctionSmoothMs, never a snap (cl_teleportDist).
  expect(o.correction).toBeLessThan(8);
  expect(o.glide).toBeLessThan(h.client.settings.teleportDist);
  expect(worstStep(h.frames, fromMs)).toBeLessThanOrEqual(1);
}

/** The lossy WAN runs: one per profile and seed. */
export const LOSSY_CASES = ["wan-100-loss1", "wan-150-loss2"].flatMap((name) =>
  LOSSY_SEEDS.map((seed) => [name, seed] as const),
);

export function lossyCase(name: string, seed: number): void {
  const h = run(profile(name), seed);
  expectCircuit(h);
  expectConverged(h);
  const t = h.totals();
  expect(t.corrections / SECONDS).toBeLessThan(1);
  expect(t.meanCorrection).toBeLessThan(2);
  expect(t.hardResyncs).toBe(0);
  expect(Math.max(...h.frames.offset)).toBeLessThan(8);
  expect(worstStep(h.frames)).toBeLessThanOrEqual(1);
  // Every correction is logged, with the fields that differed.
  expect(h.client.predictor.corrections.total).toBe(t.corrections);
}

/** The browser-like runs: every frame model on wan-50, wan-100-loss1 and wan-150-loss2, two seeds. */
export const BROWSER_LIKE_CASES = FRAME_MODELS.flatMap((frames) =>
  ["wan-50", "wan-100-loss1", "wan-150-loss2"].flatMap((name) =>
    [1, 2].map((seed) => [name, frames.name, seed, frames] as const),
  ),
);

export function browserLikeCase(
  name: string,
  seed: number,
  frames: (typeof FRAME_MODELS)[number],
): void {
  // A mean-only clock (the M2 step clock before D-028's adaptive buffer) starved here on the
  // low point of each burst: 0.6 to 8 corrections a second, up to 23 u.
  const h = run(profile(name), seed, frames);
  expectCircuit(h);
  // Frames come at 12 fps or more: 10 reconciles a second at least.
  expectConverged(h, SECONDS * 10);
  const t = h.totals();
  expect(t.corrections / SECONDS).toBeLessThan(1);
  expect(t.meanCorrection).toBeLessThan(2);
  expect(t.hardResyncs).toBe(0);
  expect(h.client.predictor.corrections.total).toBe(t.corrections);
  expectGlidesOnly(h);
  // The clock learns the rhythm from its third dip, mostly while the circuit still stands; a
  // burst deeper than any before can make it step once more later (18 runs in 90 over seeds
  // 1–10).
  expect(offsetsByCause(h).stepsMoving).toBeLessThanOrEqual(2);
  // Starved cmds while the circuit runs: under one every 10 s. The clock grows on a pattern of
  // dips, so a burst deeper than any before can still starve a tick before it does; the
  // mean-only clock starved 1 to 9 cmds a second here.
  expect(starvedMoving(h, IDLE_TICKS)).toBeLessThan(SECONDS / 10);
  const target = h.client.settings.inputBuffer;
  expect(bufferMean(h.frames)).toBeLessThan(target + BUFFER_MEAN_ABOVE_TARGET);
  expect(h.client.clock.adaptiveTicks).toBeLessThanOrEqual(MAX_ADAPTIVE_TICKS);
}
