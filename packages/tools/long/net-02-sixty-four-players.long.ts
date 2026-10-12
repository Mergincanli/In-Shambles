import { describe, it } from "vitest";
import { expectSixtyFour, runSixtyFour } from "../test/net/sixtyFour";

// NET-02 (c), the long tier (D-032; docs/05 §4.3, §14; M3 design §5, §6 increment 10; D-046): the
// real match at 64 players and 64 real clients on arena_greybox (`sixtyFour.ts` says what is
// checked, every client's stored frames among it): 30 s at wan-150-loss2 and at bad-250-loss5,
// and a 20 s respawn storm (12 players respawned and launched per tick, rotating:
// `STORM_RESPAWNS`) at wan-100-loss1, where most snapshots must leave players out.
// D-032's placement rule put all of it here: the design's 5 s fast smoke took 4.2 s of a fast
// run's wall (64 clients joining and playing), past this increment's share of the D-032 budget;
// `pnpm test` keeps NET-02 (a)'s scheduled legs through the match's own snapshot build
// (`packages/server/test/match/scheduler.test.ts`).

describe("NET-02 long: 64 players within 1100 B per snapshot (D-046)", () => {
  it.each([["wan-150-loss2"], ["bad-250-loss5"]])(
    "30 s at %s: ≤ 1100 B, nobody left out twice, client frames = sent frames",
    (name) => {
      console.log(expectSixtyFour(runSixtyFour({ profile: name, seconds: 30, seed: 5 })));
    },
    180_000,
  );

  it("a 20 s respawn storm at wan-100-loss1: ≥ 50% of the snapshots leave players out, all rules hold", () => {
    console.log(
      expectSixtyFour(
        runSixtyFour({ profile: "wan-100-loss1", seconds: 20, seed: 7, storm: true }),
      ),
    );
  }, 180_000);
});
