import { describe, it } from "vitest";
import { expectBandwidth, runBandwidth } from "../test/net/bandwidth";

// NET-08 (a), the long tier (D-032; M3 design §5, §6 increment 9; D-036, D-038): the design's
// 60 s window after all 17 are in, with the checks of the fast leg
// (`packages/tools/test/net/net-08-bandwidth.test.ts`, which measures 5 s; `bandwidth.ts`).
// D-032's placement rule put the full window here: 17 clients for 60 s cost about 5 s of a fast
// run's CPU.

describe("NET-08 long: bandwidth of 16 bots + 1 human stand-in within docs/05 §9.2 (D-036, D-038)", () => {
  it("60 s at wan-100-loss1: down ≤ 32 KB/s, up ≤ 8 KB/s, snapshots ≤ 1100 B and ≤ 0.7 × full", () => {
    console.log(expectBandwidth(runBandwidth(60, 1)));
  }, 60_000);
});
