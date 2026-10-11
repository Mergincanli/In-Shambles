import { describe, expect, it } from "vitest";
import { expectExactReplay, recordBotMatch } from "../test/replay/demoReplay";

// D-044 (M3 design §5 "Demo"), the long tier (D-032): 60 s of a 4-bot harness match on
// arena_greybox recorded into a memory sink, a fifth player joining at 20 s, then replayed
// through DemoPlayer: every frame equals the server's, the joiner's JOIN on its join tick. The
// fast smoke is packages/tools/test/replay/demo.test.ts.

describe("demo long: 60 s of a 4-bot match replay exactly (D-044)", () => {
  it("records 60 s, a joiner at 20 s, and replays every tick's frame", () => {
    const d = recordBotMatch(20_000, 60_000);
    expect(d.digests.size).toBeGreaterThanOrEqual(3590);
    expectExactReplay(d);
  }, 60_000);
});
