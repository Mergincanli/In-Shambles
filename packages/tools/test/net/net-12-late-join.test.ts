import { describe, it } from "vitest";
import { expectLateJoin, runLateJoin } from "./lateJoin";

// NET-12, the fast tier (docs/05 §14; M3 design §5, §6 increment 9; D-036, D-038): late join and
// reconnect on a compressed timeline, 12 s in all (`lateJoin.ts` says what is checked; D-032's
// placement rule: the design's 60 s smoke cost some 3.5 s of a fast run). The long tier runs the
// design's timeline over 5 simulated minutes (`packages/tools/long/net-12-late-join.long.ts`).

describe("NET-12: late join and reconnect get a full snapshot and stay in sync (D-038)", () => {
  it("8 bots, a late joiner at 3 s, slot 3 rejoined at 7 s, 12 s at wan-100-loss1", () => {
    console.log(expectLateJoin(runLateJoin({ lateAtS: 3, reconnectAtS: 7, endS: 12 }, 5)));
    // A busy host (the full fast run) takes it past Vitest's default 5 s.
  }, 30_000);
});
