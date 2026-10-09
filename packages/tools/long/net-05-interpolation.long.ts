import { describe, expect, it } from "vitest";
import { createBotInput } from "../src/bots/routes";
import {
  expectSmooth,
  FRAMES_BOT_TIMER,
  moverInput,
  pair,
  profile,
  RemoteWatch,
} from "../test/net/interpolation";
import {
  FRAMES_144HZ,
  FRAMES_BROWSER_HITCHES,
  FRAMES_SLOW_HOST,
  type FrameModel,
  framesSwitchingAt,
  type HarnessClient,
  MultiHarness,
} from "../test/net/multiHarness";
import { expectSixtyFourSmooth, runSixtyFour } from "../test/net/sixtyFour";

// NET-05 (docs/05 §14, M3 design §2.8 and §5, D-037), its long tier (D-032): the runs of
// `packages/tools/test/net/net-05-interpolation.test.ts` that `pnpm test` leaves out, with the
// same checks (`interpolation.ts`; that file's header says what they are):
// - the rest of the 2-client matrix: every profile with 144 Hz frames, browser hitches and a slow
//   host, NetSim seeds 1 and 2 (the fast tier runs seed 1 at 144 Hz on the three lighter
//   profiles), extrapolated + held ≤ 2% wherever the link is wan-150-loss2;
// - frames turning bad mid-run (144 Hz, then browser hitches or a slow host);
// - the RTT step down (150 → 50 ms) on the observer's link;
// - 16 clients on arena_greybox (the stairs mover and 15 bots running the bots' routes and random
//   walks), every client watching all 15 others for 60 s: on wan-100-loss1 at 144 Hz, and on
//   wan-150-loss2 with frames like the bots' 60 Hz timer (10–33 ms, often passing a whole bracket).
// - 64 players (D-046; `sixtyFour.ts`): 4 observers sample all 63 others at 60 Hz at the real
//   1100 B budget on wan-150-loss2 for 20 s, with the 64th client joining 5 s in (its remotes
//   snap once each, at their first appearance, never on a re-sent "new" while slots alternate
//   with pending), and through the launch storm that leaves players out of most snapshots for
//   10 s; extrapolated + held ≤ 2% in both, and no remote the newest stored frame holds hidden.

const PROFILES = ["wan-50", "wan-100-loss1", "wan-150-loss2", "bad-250-loss5"] as const;
const MODELS: readonly (readonly [string, FrameModel])[] = [
  ["144 Hz", FRAMES_144HZ],
  ["browser hitches", FRAMES_BROWSER_HITCHES],
  ["a slow host", FRAMES_SLOW_HOST],
];
/** The fast tier's cases: seed 1 at 144 Hz on wan-50, wan-100-loss1 and wan-150-loss2. */
function inFastTier(name: string, model: string, seed: number): boolean {
  return seed === 1 && model === "144 Hz" && name !== "bad-250-loss5";
}
const MATRIX = PROFILES.flatMap((name) =>
  MODELS.flatMap(([model]) => [1, 2].map((seed) => [name, model, seed] as const)),
).filter(([name, model, seed]) => !inFastTier(name, model, seed));

describe("NET-05: remote interpolation is continuous", () => {
  it.each(MATRIX)(
    "%s, %s, seed %i: a stairs-climbing strafe-jumper is drawn smoothly",
    (name, model, seed) => {
      const frames = (MODELS.find(([m]) => m === model) as readonly [string, FrameModel])[1];
      const r = pair({ profile: name, seed, frames });
      r.h.run(20_000);
      console.log(r.watch.summary(`NET-05 ${name} ${model} seed ${seed}`));
      expectSmooth(r.watch);
      if (name === "wan-150-loss2") expect(r.watch.heldShare).toBeLessThanOrEqual(0.02);
    },
  );

  it.each(
    ["wan-100-loss1", "wan-150-loss2"].flatMap((name) =>
      [MODELS[1], MODELS[2]].map((m) => [name, (m as readonly [string, FrameModel])[0]] as const),
    ),
  )("%s, 144 Hz then %s 8 s in: smooth throughout", (name, model) => {
    const frames = (MODELS.find(([m]) => m === model) as readonly [string, FrameModel])[1];
    const r = pair({ profile: name, frames: framesSwitchingAt(8000, FRAMES_144HZ, frames) });
    r.h.run(20_000);
    console.log(r.watch.summary(`NET-05 ${name} 144 Hz then ${model}`));
    expectSmooth(r.watch);
    if (name === "wan-150-loss2") expect(r.watch.heldShare).toBeLessThanOrEqual(0.02);
  });

  it("an RTT step down on the observer's link: smooth, the delay falling back", () => {
    const r = pair({ profile: "wan-150-loss2", seed: 2 });
    r.h.run(8000);
    const delay = r.observer.client.remotes.delayTicks;
    r.watch.heldSince = r.h.now;
    r.observer.sim?.setProfile(profile("wan-50"));
    r.h.run(8000);
    console.log(
      `${r.watch.summary("NET-05 RTT step 150 → 50 ms")}, after it ${r.watch.heldMsAfter.toFixed(0)} ms`,
    );
    expectSmooth(r.watch);
    expect(r.watch.heldMsAfter).toBeLessThanOrEqual(600);
    expect(r.observer.client.remotes.delayTicks).toBeLessThanOrEqual(delay);
  });

  it.each([
    ["wan-100-loss1", "144 Hz"],
    ["wan-150-loss2", "the bots' 60 Hz timer"],
  ] as const)(
    "%s, %s, 16 clients: every client draws the 15 others smoothly for 60 s",
    (name, model) => {
      const frames = model === "144 Hz" ? FRAMES_144HZ : FRAMES_BOT_TIMER;
      const h = new MultiHarness({ map: "arena_greybox", seed: 11 });
      const watches: RemoteWatch[] = [];
      const clients: HarnessClient[] = [];
      for (let i = 0; i < 16; i++) {
        const k = i;
        clients.push(
          h.addClient({
            input: i === 0 ? moverInput(11) : createBotInput("arena_greybox", i, 11),
            profile: profile(name),
            frameIntervalMs: frames,
            record: i === 0,
            onFrame: () => watches[k]?.sample(),
          }),
        );
      }
      const mover = clients[0] as HarnessClient;
      for (const c of clients) {
        watches.push(
          new RemoteWatch(
            c.client,
            c.client.world,
            (s) => (s === mover.session?.clientId ? mover.server : null),
            () => h.now,
          ),
        );
      }
      h.run(62_000);
      let remoteFrames = 0;
      let held = 0;
      for (let i = 0; i < watches.length; i++) {
        const w = watches[i] as RemoteWatch;
        expectSmooth(w);
        // Everyone sees the 15 others.
        expect(w.client.remotes.view.count).toBe(15);
        remoteFrames += w.remoteFrames;
        held += w.extrapolated + w.held;
      }
      console.log(`NET-05 ${name} 16 clients: ${watches[1]?.summary("client 1")}`);
      console.log(
        `NET-05 ${name} 16 clients: ${remoteFrames} remote-frames, ` +
          `${((100 * held) / remoteFrames).toFixed(2)}% extrapolated or held`,
      );
      if (name === "wan-150-loss2") expect(held / remoteFrames).toBeLessThanOrEqual(0.02);
    },
    60_000,
  );

  it("64 players at wan-150-loss2: 4 observers draw all 63 others smoothly, a late joiner's remotes snap once", () => {
    const run = runSixtyFour({
      profile: "wan-150-loss2",
      seconds: 20,
      seed: 13,
      observers: 4,
      checked: 0,
      lateJoinMs: 5000,
    });
    expect(run.watch.failures).toEqual([]);
    console.log(expectSixtyFourSmooth(run));
  }, 180_000);

  it("64 players through the launch storm: 4 observers draw all 63 others smoothly", () => {
    const run = runSixtyFour({
      profile: "wan-100-loss1",
      seconds: 10,
      seed: 17,
      observers: 4,
      checked: 0,
      storm: true,
    });
    expect(run.watch.failures).toEqual([]);
    expect(run.windowDeferred / run.windowSnapshots).toBeGreaterThanOrEqual(0.5);
    console.log(expectSixtyFourSmooth(run));
  }, 180_000);
});
