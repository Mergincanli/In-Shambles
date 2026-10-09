import { describe, it } from "vitest";
import { expectDeltaMatch, runDeltaMatch } from "../test/net/deltaMatch";

// NET-02 (b), the long tier (D-032; M3 design §5, §6 increment 9; D-038): the fast leg's run
// (`packages/tools/test/net/net-02-delta-match.test.ts`, checks in `deltaMatch.ts`) for 60 s on
// two seeds.

describe("NET-02 long: delta snapshots in the match over bad-250-loss5 (D-038)", () => {
  it.each([[3], [11]])(
    "60 s, 4 clients, seed %i: baseBack = T − ackTick, client frames = server frames, ≥ 90% deltas",
    (seed) => {
      console.log(expectDeltaMatch(runDeltaMatch(60, seed)));
    },
    60_000,
  );
});
