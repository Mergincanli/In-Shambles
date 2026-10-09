import { STAT_COUNT, STAT_DILATION, StrafeCircuit } from "@game/client/net";
import { TICK_RATE } from "@game/shared";
import { describe, expect, it } from "vitest";
import { FRAMES_144HZ, NetHarness } from "./harness";
import {
  describeStep,
  dilationTicks,
  FAR,
  failures,
  NEAR,
  report,
  runStep,
  SPEC_DIL_MAX,
} from "./timeDilation";

// NET-07 (docs/05 §14, M3 design §2.7 and §5, D-039): the input buffer re-converges after a
// round-trip step, 50 → 150 ms within 2 s (spec) and back within 4 s (design), at no more than
// ±3% dilation. The NET harness drives the StrafeCircuit bot and steps the link mid-circuit from
// one-way 25 ms to 75 ms (jitter ±3 ms, no loss) or back. Each step is judged (`timeDilation.ts`
// says how) on: re-converged within the bound, |δ| ≤ 0.03 every frame and ticks per wall second
// within [0.97, 1.03] over 0.5 s windows outside step frames, and from the step on: at most 2
// fast-forwards, no holds, no hard resync, corrections under 1 a second after the bound and at
// most 20 for the step's own starve before it (D-039's reading), δ changing sign at most twice
// once re-converged, and at 144 Hz going up δ > 0 for at least 0.3 s and the mean within
// target ± 0.5 (+ the spread, as the metric reads it) over the bound's last 0.5 s. The control
// runs the same clock with dilation off (its steps kept, D-028's machinery): it must fail both
// ways, or dilation is not what passes. The dilation stat (`STAT_DILATION`) is checked against
// the frames' own δ.
// Tiers (D-032): this file runs seed 1 at 144 Hz both ways and the control; seeds 2–3, the
// browser-hitch frames and the control on every seed run in `pnpm test:long`
// (`packages/tools/long/net-07-time-dilation.long.ts`).

describe("NET-07: time dilation after a round-trip step", () => {
  it.each([true, false])("144 Hz, seed 1, up %s: re-converges within the bound at ±3%", (up) => {
    const run = runStep(up, 1, "144 Hz");
    const rep = report(run);
    console.log(describeStep(`${up ? "up" : "down"} 144 Hz seed 1`, rep));
    expect(failures(rep, up, "144 Hz")).toEqual([]);
    // The netgraph's stat sums what dilation added: about +1.4 ticks going up, −2.4 going down.
    const added = run.h.client.stats.totals[STAT_DILATION] as number;
    expect(added).toBeCloseTo(dilationTicks(run.h.frames), 9);
    if (up) expect(added).toBeGreaterThan(0.5);
    else expect(added).toBeLessThan(-1.5);
  });

  it("STAT_DILATION leaves a stall frame's gain out, so its mean over a second stays within ±3%", () => {
    // 144 Hz, then one 900 ms frame while the up-step's speed-up runs (most of it dropped).
    let stall = false;
    const h = new NetHarness({
      input: new StrafeCircuit(),
      profile: NEAR,
      seed: 1,
      frameIntervalMs: (rng) => {
        if (!stall) return FRAMES_144HZ(rng);
        stall = false;
        return 900;
      },
    });
    h.runTicks(300);
    h.sim?.setProfile(FAR);
    while (h.client.clock.dilation <= 0) h.run(10);
    stall = true;
    const second = new Float64Array(STAT_COUNT);
    let worst = 0;
    for (let ms = 0; ms < 2500; ms += 10) {
      h.run(10);
      h.client.stats.lastSecond(second);
      worst = Math.max(worst, Math.abs(second[STAT_DILATION] as number) / TICK_RATE);
    }
    expect(
      Math.max(...h.frames.time.slice(1).map((t, i) => t - (h.frames.time[i] as number))),
    ).toBeGreaterThan(800);
    expect(h.client.stats.totals[STAT_DILATION] as number).toBeCloseTo(dilationTicks(h.frames), 9);
    expect(worst).toBeLessThanOrEqual(SPEC_DIL_MAX + 0.002);
  });

  it.each([true, false])("the dilation-off control fails (144 Hz, seed 1, up %s)", (up) => {
    const rep = report(runStep(up, 1, "144 Hz", false));
    console.log(describeStep(`${up ? "up" : "down"} 144 Hz seed 1, control`, rep));
    // Without δ the fast-forward leaves the low edge a tick short going up, and nothing gives back
    // the 3 ticks of extra lead going down (no hold under target + 6).
    expect(failures(rep, up, "144 Hz")).toContain("re-converged");
    // Going up the up-step rule's mean half catches it too, not only its speed-up half.
    if (up) expect(rep.boundMeanOut).toBeGreaterThan(0.2);
    expect(rep.maxAbsDilation).toBe(0);
  });
});
