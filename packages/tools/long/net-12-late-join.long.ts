import { describe, it } from "vitest";
import { expectLateJoin, runLateJoin } from "../test/net/lateJoin";

// NET-12, the long tier (D-032; M3 design §5, §6 increment 9; D-036, D-038): the design's
// timeline, a late joiner at 10 s and slot 3 rejoined at 30 s, then 5 simulated minutes of bot
// play in all, with the fast leg's checks (`packages/tools/test/net/net-12-late-join.test.ts`;
// `lateJoin.ts`).

describe("NET-12 long: late join and reconnect stay in sync over 5 minutes (D-038)", () => {
  it("8 bots, a late joiner at 10 s, slot 3 rejoined at 30 s, 300 s at wan-100-loss1", () => {
    console.log(expectLateJoin(runLateJoin({ lateAtS: 10, reconnectAtS: 30, endS: 300 }, 5)));
  }, 120_000);
});
