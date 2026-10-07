import { MAX_ADAPTIVE_TICKS, MixedInput, StrafeCircuit } from "@game/client/net";
import { findNetProfile, NET_PROFILES, type NetProfile } from "@game/shared";
import { describe, expect, it } from "vitest";
import {
  FRAMES_144HZ,
  FRAMES_BROWSER_HITCHES,
  FRAMES_SLOW_HOST,
  FRAMES_SLOWER_HOST,
  type FrameLog,
  type FrameModel,
  framesSwitchingAt,
  NetHarness,
} from "./harness";

// NET-04, the M2 basic version (docs/05 §14, M2 design §5): the automated stand-in for "smooth at
// net_profile wan-150-loss2". The NET-03 harness drives the StrafeCircuit bot (laps of a square on
// movement_lab, strafe-jumping well past the run cap) for 60 s on every docs/10 §3 profile,
// through NetSim with a fixed seed:
// - lan and wan-50: 0 corrections;
// - wan-100-loss1 and wan-150-loss2: under 1 correction per second, mean under 2 u, render offset
//   never 8 u or more, and no frame-to-frame jump in the drawn position (each step at most
//   speed × frame time × 1.5 + 0.5 u);
// - bad-250-loss5: converges (no hard resync, laps go on, the buffer settles) and logs every
//   correction;
// - browser-like frame timing (60 fps with 15% of the frames 50–80 ms, or every frame 33–83 ms or
//   50–83 ms) on wan-50, wan-100-loss1 and wan-150-loss2, from the start or turning bad
//   mid-circuit: the same bounds as the lossy profiles for the corrections' render offset, the
//   clock's own steps gliding (under cl_teleportDist) and rare, and the buffer's latency bounded
//   (D-028's adaptive input buffer).
// On every profile the prediction converges: at each snapshot the client reconciled with, its
// standing prediction equals the server's recorded state (`NetHarness.unreconciled`), so a
// predictor that stopped correcting fails here, not only in its unit tests.
// One summary line per profile is printed. The full NET-04 (16 bots, every mechanic) comes with M3.

/** The circuit stands still this long first (StrafeCircuit's default), then strafe-jumps 60 s. */
const IDLE_TICKS = 90;
const TICKS = 3600;
const SECONDS = TICKS / 60;
/**
 * NetSim seeds. The lossy WAN profiles run three: corrections are rare there (0 to about 12 a
 * minute, all under a unit), and seeds 5 and 7 have some, so the smoothing path is exercised too.
 */
const SEED = 1;
const LOSSY_SEEDS = [1, 5, 7];

/**
 * The largest frame-to-frame step of the drawn position over its allowance (≤ 1 passes), from
 * `fromMs` (harness time) on.
 */
function worstStep(f: FrameLog, fromMs = 0): number {
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
function starvedMoving(h: NetHarness, idleTicks: number): number {
  const moving = h.client.startTick + idleTicks;
  return h.serverStarved.filter((tick) => tick > moving).length;
}

/** The mean of the clock's buffer health over the frames from `from` on, ticks. */
function bufferMean(f: FrameLog, from = 0): number {
  let sum = 0;
  for (let i = from; i < f.buffer.length; i++) sum += f.buffer[i] as number;
  return sum / Math.max(1, f.buffer.length - from);
}

function run(
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
function expectCircuit(h: NetHarness): void {
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
function expectConverged(h: NetHarness, minReconciles = TICKS / 2): void {
  expect(h.snapshotTicks.length).toBeGreaterThan(minReconciles);
  expect(h.unreconciled()).toEqual([]);
}

const profile = (name: string) => findNetProfile(name) as NetProfile;

describe("NET-04 (M2 basic): reconciliation on every profile", () => {
  it("covers every docs/10 §3 profile", () => {
    expect(NET_PROFILES.map((p) => p.name)).toEqual([
      "lan",
      "wan-50",
      "wan-100-loss1",
      "wan-150-loss2",
      "bad-250-loss5",
    ]);
  });

  it.each(["lan", "wan-50"])("%s: a 60 s strafe-jump circuit needs 0 corrections", (name) => {
    const h = run(profile(name));
    expectCircuit(h);
    expectConverged(h);
    const t = h.totals();
    expect(t.corrections).toBe(0);
    expect(t.hardResyncs).toBe(0);
    expect(Math.max(...h.frames.offset)).toBe(0);
    expect(worstStep(h.frames)).toBeLessThanOrEqual(1);
    // Steady frames on a clean link: the adaptive buffer adds nothing (D-028).
    expect(t.starved).toBe(0);
    expect(bufferMean(h.frames)).toBeLessThanOrEqual(h.client.settings.inputBuffer + 0.5);
  });

  it.each(
    ["wan-100-loss1", "wan-150-loss2"].flatMap((name) => LOSSY_SEEDS.map((seed) => [name, seed])),
  )("%s, seed %i: corrections rare and small, no visible rubber-banding", (name, seed) => {
    const h = run(profile(name as string), seed as number);
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
  });

  it("bad-250-loss5: converges and logs its corrections", () => {
    // Seed 7: the adaptive buffer covers most of this link's jitter (0 to 3 corrections a minute
    // over seeds 1–12), and this seed has some, so the correction path runs.
    const h = run(profile("bad-250-loss5"), 7);
    expectCircuit(h);
    expectConverged(h);
    const t = h.totals();
    // The link is bad enough that the correction path runs.
    expect(t.corrections).toBeGreaterThan(0);
    const c = h.client;
    expect(t.hardResyncs).toBe(0);
    // The buffer settles: the low edge at the margin or above (cl_inputBuffer − 1), the mean above
    // it by the link's spread (±40 ms of jitter, about 5 ticks), within the adaptive cap.
    expect(c.clock.bufferLow).toBeGreaterThanOrEqual(c.settings.inputBuffer - 1);
    expect(c.clock.bufferHealth).toBeLessThan(c.settings.inputBuffer + MAX_ADAPTIVE_TICKS);
    const log = c.predictor.corrections;
    expect(log.total).toBe(t.corrections);
    for (let i = 0; i < log.count; i++) {
      const r = log.at(i);
      expect(r.diff().length, `correction at tick ${r.tick}`).toBeGreaterThan(0);
      expect(r.latestTick).toBeGreaterThanOrEqual(r.tick);
    }
    if (log.count > 0) {
      const r = log.at(log.count - 1);
      console.log(`NET-04 bad-250-loss5 last correction, tick ${r.tick}: ${r.diff().join(", ")}`);
    }
  });

  it("re-anchors the clock in steps after a round-trip step up and down (smooth dilation is NET-07)", () => {
    const h = new NetHarness({ input: new StrafeCircuit(), profile: profile("wan-50"), seed: 3 });
    h.runTicks(600);
    const c = h.client;
    const clock = c.clock;
    const target = c.settings.inputBuffer;
    // The lead over the server's tick is the uplink delay plus the buffer, measured from the
    // server's side rather than from the clock's own EWMA.
    const lead0 = h.lead();
    expect(lead0).toBeGreaterThanOrEqual(target + 1);
    // 100 ms more round trip: the buffer runs dry, the server starves, the clock fast-forwards.
    h.sim?.setProfile(profile("wan-150-loss2"));
    h.run(4000);
    const up = h.totals();
    expect(clock.fastForwards).toBeGreaterThanOrEqual(1);
    expect(clock.holds).toBe(0);
    expect(clock.bufferHealth).toBeGreaterThan(target - 1.5);
    h.run(4000);
    expect(h.totals().corrections - up.corrections).toBeLessThanOrEqual(4);
    const leadUp = h.lead();
    expect(leadUp - lead0).toBeGreaterThanOrEqual(2);
    // Back to lan: inputs arrive 75 ms early, the clock holds and the lead shrinks to the buffer.
    h.sim?.setProfile(profile("lan"));
    h.run(4000);
    expect(clock.holds).toBeGreaterThanOrEqual(1);
    expect(h.totals().clockAdjustments).toBe(clock.fastForwards + clock.holds);
    expect(clock.bufferHealth).toBeLessThan(target + 3);
    const leadLan = h.lead();
    expect(leadUp - leadLan).toBeGreaterThanOrEqual(3);
    expect(leadLan).toBeGreaterThanOrEqual(target);
    expect(leadLan).toBeLessThanOrEqual(target + 1);
    expect(h.totals().hardResyncs).toBe(0);
    expect(h.unreconciled()).toEqual([]);
  });

  it.each([
    ["wan-50", 250, 16],
    ["wan-100-loss1", 120, 8],
  ] as const)(
    "%s: a %i ms frame hitch is caught up, not dropped (at most %i corrections)",
    (name, ms, bound) => {
      // The client's tick follows the server's clock: the ticks a hitch owes run in the next frames
      // (5 a frame), so the server starves only for the hitch itself, not until a clock step.
      const h = new NetHarness({ input: new MixedInput(), profile: profile(name), seed: 1 });
      h.runTicks(600);
      const before = h.totals();
      const lead = h.lead();
      h.hitch(ms);
      h.run(3000);
      const after = h.totals();
      expect(after.corrections - before.corrections).toBeLessThanOrEqual(bound);
      expect(after.hardResyncs).toBe(0);
      expect(after.clockAdjustments - before.clockAdjustments).toBeLessThanOrEqual(1);
      // No lead lost to the hitch (a fast-forward may have added a little).
      expect(h.lead()).toBeGreaterThanOrEqual(lead - 1);
      expect(h.unreconciled()).toEqual([]);
    },
  );
});

/** Frame models of the browser-like block (the harness's seeded draws). */
const FRAME_MODELS = [
  { name: "browser hitches", model: FRAMES_BROWSER_HITCHES },
  { name: "slow host", model: FRAMES_SLOW_HOST },
  { name: "slower host", model: FRAMES_SLOWER_HOST },
];
/**
 * Bounded latency: the buffer's mean health over the run stays under target + 5 ticks. The frame
 * rhythm costs its spread (3.4 to 5.9 ticks of mean on these seeds, up to 6.4 over seeds 1–10),
 * so a buffer grown to its cap (target + 8) or left large after a round trip fell fails.
 */
const BUFFER_MEAN_ABOVE_TARGET = 5;
/** Frames turn bad this long into the onset runs (the circuit is moving by then). */
const ONSET_MS = 15_000;
/**
 * The clock has learned a new frame rhythm this long after it set in: three dips in its window
 * (with 60 fps hitches about 0.3 s, at worst about 1.4 s over seeds 1–4).
 */
const LEARN_MS = 2000;

/**
 * The render offset split by its cause, from `fromMs` (harness time) on: within
 * cl_correctionSmoothMs of a clock step or a hard resync it is that step's glide (a fast-forward's
 * skip, a hold's slowdown, a re-anchor; the offset decays linearly over that time), otherwise a
 * correction's. Also the steps and resyncs taken while moving (over 100 u/s), and the first one.
 */
function offsetsByCause(
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
function expectGlidesOnly(h: NetHarness, fromMs = 0): void {
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

describe("NET-04 (M2 basic): browser-like frame timing", () => {
  it.each(
    FRAME_MODELS.flatMap((frames) =>
      ["wan-50", "wan-100-loss1", "wan-150-loss2"].flatMap((name) =>
        [1, 2].map((seed) => [name, frames.name, seed, frames] as const),
      ),
    ),
  )("%s, %s, seed %i: no rubber-banding, bounded buffer", (name, _model, seed, frames) => {
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
  });

  it.each(
    [FRAME_MODELS[0], FRAME_MODELS[1]].flatMap((frames) =>
      ["lan", "wan-50", "wan-100-loss1", "wan-150-loss2"].map(
        (name) => [name, (frames as (typeof FRAME_MODELS)[number]).name] as const,
      ),
    ),
  )("%s, 144 Hz then %s mid-circuit: one learning step, prompt, then smooth", (name, model) => {
    const frames = FRAME_MODELS.find((m) => m.name === model) as (typeof FRAME_MODELS)[number];
    const h = run(profile(name), 1, {
      name: `144 Hz then ${model}`,
      model: framesSwitchingAt(ONSET_MS, FRAMES_144HZ, frames.model),
    });
    expectCircuit(h);
    expectConverged(h, SECONDS * 10);
    const t = h.totals();
    const onset = offsetsByCause(h, ONSET_MS);
    // Until the third dip the bursts starve (a few corrections, up to about 20 u: the learning
    // cost, as with the mean-only clock but once), then the clock steps within LEARN_MS of the
    // onset: one fast-forward of 2–5 ticks, a forward glide of up to about 57 u at strafe speed
    // (on lan a resync or two, the first one alone left alone, D-028).
    expect(onset.firstStepMs - ONSET_MS).toBeLessThan(LEARN_MS);
    expect(onset.glide).toBeLessThan(h.client.settings.teleportDist);
    // That glide (up to about 57 u over cl_correctionSmoothMs) speeds the drawn player up past
    // NET-04's per-frame allowance for those frames: measured up to 1.61 of it (lan, a resync).
    expect(worstStep(h.frames, ONSET_MS)).toBeLessThanOrEqual(2);
    expect(t.hardResyncs).toBeLessThanOrEqual(name === "lan" ? 2 : 0);
    expect(t.corrections / SECONDS).toBeLessThan(1);
    // Once learned: the browser-like bounds, at most one more step.
    const learned = ONSET_MS + LEARN_MS;
    expectGlidesOnly(h, learned);
    expect(offsetsByCause(h, learned).stepsMoving).toBeLessThanOrEqual(1);
    const learnedTick = h.frames.tick[h.frames.time.findIndex((ms) => ms >= learned)] as number;
    expect(h.serverStarved.filter((tick) => tick > learnedTick).length).toBeLessThan(SECONDS / 10);
    expect(bufferMean(h.frames)).toBeLessThan(
      h.client.settings.inputBuffer + BUFFER_MEAN_ABOVE_TARGET,
    );
  });

  it("lan, browser hitches: gaps past the lead resync until the lead has learned the rhythm", () => {
    // On lan the lead is all buffer, so a long frame overtakes the prediction and re-anchors
    // before any snapshot could show the dip; the second resync within the window grows the lead
    // by its depth plus cl_inputBuffer (the first alone is left alone, like a lone dip).
    const h = run(profile("lan"), 1, FRAME_MODELS[0]);
    expectCircuit(h);
    expectConverged(h, SECONDS * 10);
    const t = h.totals();
    expect(t.hardResyncs).toBeLessThanOrEqual(2);
    expect(t.corrections / SECONDS).toBeLessThan(1);
    expect(h.client.clock.adaptiveTicks).toBeGreaterThan(0);
    // The resyncs and steps glide (a re-anchor's offset at strafe speed: up to about 56 u).
    expectGlidesOnly(h);
    expect(offsetsByCause(h).stepsMoving).toBeLessThanOrEqual(3);
    expect(bufferMean(h.frames)).toBeLessThan(
      h.client.settings.inputBuffer + BUFFER_MEAN_ABOVE_TARGET,
    );
  });
});
