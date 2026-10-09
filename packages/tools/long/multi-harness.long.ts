import { MixedInput, NeutralInput, StrafeCircuit } from "@game/client/net";
import { findNetProfile, MSG_SNAPSHOT, type NetProfile, SNAP_FIT_MAX_PLAYERS } from "@game/shared";
import { describe, expect, it } from "vitest";
import { type HarnessClient, MultiHarness } from "../test/net/multiHarness";

// The multi-client harness's long run (M3 design §5 "Harness", §6 increment 3), the long tier's
// (D-032): a full 37-player match. The 16-client baseline that also lived here (30 s of 16 clients
// on one fake clock, increment 3) became NET-04's 16-client leg on seed 1 in increment 9
// (`net-04-reconciliation.long.ts`). The harness's own tests stay in `pnpm test`
// (`packages/tools/test/net/multi-harness.test.ts`).

const profile = (name: string) => findNetProfile(name) as NetProfile;

describe("MultiHarness: clients", () => {
  // 37 players, the largest match whose every snapshot fits 1100 B by construction (D-034): the
  // byte-budget scheduler (D-046) never runs; the 64-player matches are NET-02's and NET-05's.
  it("plays a full 37-player match (sv_maxClients 37, every snapshot fitting by construction), refuses a 38th, and refills a slot", () => {
    const h = new MultiHarness({ map: "arena_greybox", seed: 9, maxClients: SNAP_FIT_MAX_PLAYERS });
    const full = h.match.maxClients;
    expect(full).toBe(37);
    const wan = profile("wan-100-loss1");
    for (let i = 0; i < full; i++) {
      h.addClient({
        input: i % 2 === 0 ? new MixedInput() : new StrafeCircuit(),
        profile: wan,
        record: i === 3,
      });
    }
    h.run(2000);
    expect(h.clients.map((c) => c.session?.clientId)).toEqual(
      Array.from({ length: full }, (_, i) => i),
    );
    expect(h.active.length).toBe(full);
    for (const c of h.clients) {
      expect(c.client.active).toBe(true);
      // Within 1100 B by construction (D-034): at most the worst delta of 37 players, 1088 B, and
      // a full one (on joining) lists at most the other 36 as new bodies, 86 + 199 + 7 + 36 × 213
      // bits, 995 B.
      expect(c.tap.down.maxByType[MSG_SNAPSHOT]).toBeLessThanOrEqual(1088);
      expect(c.tap.maxFullSnapshot).toBeLessThanOrEqual(995);
    }
    // The links' delays spread the joins over a few ticks, so only the clients in last get all 36
    // others in their first snapshot (the earliest got fewer).
    expect(Math.max(...h.clients.map((c) => c.tap.maxFullSnapshot))).toBe(995);
    const watched = h.clients[3] as HarnessClient;
    expect(watched.client.store.newest?.presentCount).toBe(full);
    expect(watched.digestsChecked).toBeGreaterThan(50);
    expect(watched.digestMismatches).toEqual([]);
    expect(h.match.metrics.strikes).toBe(0);
    expect([h.match.metrics.sizePasses, h.match.mirrors.allocated]).toEqual([0, 0]);
    // The match KICKs a 38th connection itself; the harness refuses a 38th client.
    const extra = h.addRaw();
    h.run(100);
    expect(extra.session).toBeNull();
    expect(extra.closedReason).toBe("server full");
    expect(() => h.addClient({ input: new NeutralInput() })).toThrow(/37 clients/);

    // A left session holds its slot until its close crosses the link.
    const gone = h.clients[5] as HarnessClient;
    gone.leave();
    expect(h.active.length).toBe(full - 1);
    expect(() => h.addClient({ input: new NeutralInput() })).toThrow(/37 clients/);
    h.runUntil(() => h.match.session(5) === undefined, 1000, "slot 5 freed");
    const back = h.addClient({ input: new MixedInput(), profile: wan });
    h.run(1000);
    expect(back.session?.clientId).toBe(5);
    expect(back.client.active).toBe(true);
  });
});
