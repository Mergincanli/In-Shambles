import { describe, expect, it } from "vitest";
import {
  describeStep,
  type FrameModelName,
  failures,
  report,
  runStep,
} from "../test/net/timeDilation";

// NET-07 (docs/05 §14, M3 design §2.7 and §5, D-039), its long tier (D-032): the runs
// `packages/tools/test/net/net-07-time-dilation.test.ts` leaves out, with the same checks
// (`timeDilation.ts`); that file's header says what they check.
// - 144 Hz on seeds 2 and 3, both ways (the fast tier runs seed 1);
// - browser-hitch frames (60 fps, 15% of the frames 50–80 ms) on seeds 1–3, both ways;
// - the dilation-off control on seeds 2 and 3 at 144 Hz both ways and with hitches going down: it
//   must miss the re-converged bound. With hitches the bursts' own spread (about 4 ticks, which
//   the metric's M bound allows for) hides the tick a fast-forward leaves short going up, so the
//   control passes there and the hitch up-steps are regression checks of the clock, not proof of
//   dilation (D-039); at 144 Hz the up-step rule also catches the control (no speed-up, the mean a
//   tick or two off at the bound).

const CASES: [FrameModelName, number][] = [
  ["144 Hz", 2],
  ["144 Hz", 3],
  ["browser hitches", 1],
  ["browser hitches", 2],
  ["browser hitches", 3],
];

describe("NET-07: time dilation after a round-trip step", () => {
  it.each(
    CASES.flatMap(([frames, seed]) => [true, false].map((up) => [frames, seed, up] as const)),
  )("%s, seed %i, up %s: re-converges within the bound at ±3%", (frames, seed, up) => {
    const rep = report(runStep(up, seed, frames));
    console.log(describeStep(`${up ? "up" : "down"} ${frames} seed ${seed}`, rep));
    expect(failures(rep, up, frames)).toEqual([]);
  });

  it.each([
    ["144 Hz", 2, true],
    ["144 Hz", 2, false],
    ["144 Hz", 3, true],
    ["144 Hz", 3, false],
    ["browser hitches", 1, false],
    ["browser hitches", 2, false],
    ["browser hitches", 3, false],
  ] as const)("the dilation-off control fails (%s, seed %i, up %s)", (frames, seed, up) => {
    const rep = report(runStep(up, seed, frames, false));
    console.log(describeStep(`${up ? "up" : "down"} ${frames} seed ${seed}, control`, rep));
    expect(failures(rep, up, frames)).toContain("re-converged");
    if (up) expect(rep.boundMeanOut).toBeGreaterThan(0.2);
    expect(rep.maxAbsDilation).toBe(0);
  });
});
