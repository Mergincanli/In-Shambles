import { MAX_ADAPTIVE_TICKS, MixedInput, StrafeCircuit } from "@game/client/net";
import { NET_PROFILES } from "@game/shared";
import { describe, expect, it } from "vitest";
import { NetHarness } from "./harness";
import {
  BROWSER_LIKE_CASES,
  browserLikeCase,
  bufferMean,
  expectCircuit,
  expectConverged,
  LOSSY_CASES,
  lossyCase,
  profile,
  run,
  SEED,
  worstStep,
} from "./reconciliation";

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
// Tiers (D-032): this file runs one NetSim seed per profile and one browser-like case
// (wan-100-loss1, browser hitches, seed 1) in `pnpm test`; the other lossy seeds, the other
// browser-like cases, the onset runs and lan with 60 fps hitches run in `pnpm test:long`
// (`packages/tools/long/net-04-reconciliation.long.ts`). The runs and checks are shared
// (`reconciliation.ts`); `pnpm test:net` runs both tiers.

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

  it.each(LOSSY_CASES.filter(([, seed]) => seed === SEED))(
    "%s, seed %i: corrections rare and small, no visible rubber-banding",
    lossyCase,
  );

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

describe("NET-04 (M2 basic): browser-like frame timing", () => {
  it.each(
    BROWSER_LIKE_CASES.filter(
      ([name, model, seed]) =>
        name === "wan-100-loss1" && model === "browser hitches" && seed === 1,
    ),
  )("%s, %s, seed %i: no rubber-banding, bounded buffer", (name, _model, seed, frames) =>
    browserLikeCase(name, seed, frames),
  );
});
