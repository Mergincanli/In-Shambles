import { DemoPlayer } from "@game/client/net";
import { MemoryDemoSink } from "@game/server";
import { createCollisionWorld, EVK_PLAYER_JOIN, frameDigest, validateDemo } from "@game/shared";
import { expect } from "vitest";
import { createBotInput } from "../../src/bots/routes";
import { MultiHarness } from "../net/multiHarness";

// The record → replay check of D-044 (M3 design §5 "Demo"), shared by the fast smoke
// (test/replay/demo.test.ts) and the 60 s long leg (long/demo-replay.long.ts).

const NO_WORLD = createCollisionWorld([]);

/** Plays `bytes` through DemoPlayer to its END: each snapshot tick's spectator digest. */
export function replay(bytes: Uint8Array): Map<number, number> {
  const check = validateDemo(bytes);
  if (!check.ok) throw new Error(check.error);
  const seen = new Map<number, number>();
  const demo = new DemoPlayer({
    bytes,
    header: check.header,
    world: NO_WORLD,
    clock: () => 0,
    onSnapshot: (t, f) => seen.set(t, frameDigest(f, -1)),
  });
  demo.playUntil(check.summary.endTick);
  expect(demo.ended).toBe(true);
  expect(demo.faults).toBe(0);
  return seen;
}

export interface BotMatchDemo {
  readonly bytes: Uint8Array;
  /** The server's world frame digest (as a spectator) of every tick recorded. */
  readonly digests: Map<number, number>;
  /** The joiner's client id and spawn (join) tick. */
  readonly joinerId: number;
  readonly joinTick: number;
}

/**
 * 4 bots on arena_greybox (the bots' routes and walks), recorded from 1.4 s in: a fifth joins
 * `joinAtMs` into the recording, which runs `ms` in all.
 */
export function recordBotMatch(joinAtMs: number, ms: number): BotMatchDemo {
  const h = new MultiHarness({ map: "arena_greybox", seed: 16 });
  for (let i = 0; i < 4; i++) {
    h.addClient({ input: createBotInput("arena_greybox", i, 16) });
    h.run(100);
  }
  h.run(1000);
  const sink = new MemoryDemoSink();
  h.match.startRecording(sink, "memory");
  const digests = new Map<number, number>();
  h.afterServerTick = () => digests.set(h.match.serverTick, frameDigest(h.match.worldFrame, -1));
  h.run(joinAtMs);
  const joiner = h.addClient({ input: createBotInput("arena_greybox", 4, 16) });
  h.run(ms - joinAtMs);
  h.match.stopRecording();
  h.stop();
  return {
    bytes: sink.bytes(),
    digests,
    joinerId: joiner.session?.clientId ?? -1,
    joinTick: joiner.session?.spawnTick ?? -1,
  };
}

/** Every replayed frame equals the server's, and the joiner's JOIN came on its join tick. */
export function expectExactReplay(d: BotMatchDemo): void {
  const seen = replay(d.bytes);
  expect(seen.size).toBe(d.digests.size);
  let wrong = 0;
  for (const [t, digest] of seen) if (d.digests.get(t) !== digest) wrong++;
  expect(wrong).toBe(0);
  expect(d.joinTick).toBeGreaterThan(0);
  const joins: number[] = [];
  validateDemo(d.bytes, d.bytes.length, {
    events: (t, m) => {
      for (let i = 0; i < m.count; i++) {
        const e = m.events[i];
        if (e?.kind === EVK_PLAYER_JOIN && e.clientId === d.joinerId) joins.push(t);
      }
    },
  });
  expect(joins).toEqual([d.joinTick]);
}
