import { describe, it } from "vitest";
import { expectBandwidth, runBandwidth } from "./bandwidth";

// NET-08 (a), the fast tier (docs/05 §9.2, §14; M3 design §5, §6 increment 9; D-036, D-038): 16
// bots and a human stand-in through the real match, a 5 s window once all are in (`bandwidth.ts`
// says what is checked). The long tier measures the design's 60 s window
// (`packages/tools/long/net-08-bandwidth.long.ts`); the 32-player report (b) joins with D-046.

describe("NET-08: bandwidth of 16 bots + 1 human stand-in within docs/05 §9.2 (D-036, D-038)", () => {
  it("5 s at wan-100-loss1: down ≤ 32 KB/s, up ≤ 8 KB/s, snapshots ≤ 1100 B and ≤ 0.7 × full", () => {
    console.log(expectBandwidth(runBandwidth(5, 1)));
    // A busy host (the full fast run) takes it past Vitest's default 5 s.
  }, 30_000);
});
