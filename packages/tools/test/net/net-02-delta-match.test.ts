import { describe, it } from "vitest";
import { expectDeltaMatch, runDeltaMatch } from "./deltaMatch";
import { setHarnessPrimerDefault } from "./multiHarness";

// NET-02 (b), the fast tier (docs/05 §14; M3 design §5, §6 increment 9; D-038): 15 s of the real
// match and 4 real clients over bad-250-loss5, every snapshot watched and every stored frame
// checked against the server's (`deltaMatch.ts` says how). The long tier runs 60 s
// (`packages/tools/long/net-02-delta-match.long.ts`); NET-02 (a), the codec and store unit, is
// `packages/shared/test/net/delta.test.ts`, and the match's rule alone a NET-02 describe in
// `packages/server/test/match/match.test.ts`.

// This file's checks are logical, so it skips the pmove primer to keep D-032's budget; NET-03,
// NET-09 and the long tier run with it (D-040, reading 8).
setHarnessPrimerDefault(false);

describe("NET-02 (b): delta snapshots in the match over bad-250-loss5 (D-038)", () => {
  it("15 s, 4 clients: baseBack = T − ackTick, client frames = server frames, ≥ 90% deltas", () => {
    console.log(expectDeltaMatch(runDeltaMatch(15, 3)));
  }, 30_000);
});
