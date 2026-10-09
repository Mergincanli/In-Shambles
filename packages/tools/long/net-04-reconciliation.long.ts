import { describe, expect, it } from "vitest";
import { FRAMES_144HZ, framesSwitchingAt } from "../test/net/harness";
import {
  BROWSER_LIKE_CASES,
  BUFFER_MEAN_ABOVE_TARGET,
  browserLikeCase,
  bufferMean,
  expectCircuit,
  expectConverged,
  expectGlidesOnly,
  FRAME_MODELS,
  LEARN_MS,
  LOSSY_CASES,
  lossyCase,
  ONSET_MS,
  offsetsByCause,
  profile,
  run,
  SECONDS,
  SEED,
  worstStep,
} from "../test/net/reconciliation";

// NET-04, the M2 basic version (docs/05 §14, M2 design §5), its long tier (D-032): the runs of
// `packages/tools/test/net/net-04-reconciliation.test.ts` that `pnpm test` leaves out, with the
// same checks (`reconciliation.ts`), seeds and names. That file's header says what they check.
// - wan-100-loss1 and wan-150-loss2 on NetSim seeds 5 and 7 (the fast tier runs seed 1), which
//   have some corrections, so the smoothing path is exercised;
// - browser-like frame timing: every frame model on wan-50, wan-100-loss1 and wan-150-loss2 with
//   seeds 1 and 2, but the fast tier's one (wan-100-loss1, browser hitches, seed 1);
// - the onset runs: 144 Hz turning into browser hitches or a slow host 15 s into the circuit, lan
//   included;
// - lan with 60 fps hitches, where gaps past the lead resync until the lead has learned them.
// M3 increment 9 adds the 16-client legs here.

describe("NET-04 (M2 basic): reconciliation on every profile", () => {
  it.each(LOSSY_CASES.filter(([, seed]) => seed !== SEED))(
    "%s, seed %i: corrections rare and small, no visible rubber-banding",
    lossyCase,
  );
});

describe("NET-04 (M2 basic): browser-like frame timing", () => {
  it.each(
    BROWSER_LIKE_CASES.filter(
      ([name, model, seed]) =>
        !(name === "wan-100-loss1" && model === "browser hitches" && seed === 1),
    ),
  )("%s, %s, seed %i: no rubber-banding, bounded buffer", (name, _model, seed, frames) =>
    browserLikeCase(name, seed, frames),
  );

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
