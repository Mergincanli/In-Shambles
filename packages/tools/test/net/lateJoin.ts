import { findNetProfile, type NetProfile } from "@game/shared";
import { expect } from "vitest";
import { createBotInput } from "../../src/bots/routes";
import { DeltaWatch, ticksIn } from "./deltaWatch";
import { expectNoStrikes } from "./honest";
import { FRAMES_BOT_TIMER } from "./interpolation";
import { FRAMES_BROWSER_HITCHES, type HarnessClient, MultiHarness } from "./multiHarness";

// NET-12, shared by its two tiers (docs/05 §14; M3 design §5, §6 increment 9; D-036, D-038): 8
// bots on arena_greybox at wan-100-loss1; a late joiner; later one of the bots disconnects and a
// new client (a fresh session: a new HELLO) takes its freed slot. The fast tier compresses the
// timeline into 12 s (a late join at 3 s, a rejoin at 7 s), the long tier runs the design's (10 s,
// 30 s) over 5 simulated minutes.
// - The late joiner's first snapshot is full and lists every player, and so is the rejoined
//   client's: a new session starts with no baseline (D-038).
// - Every other client sees the slot's player removed, then the new one with the next teleport
//   counter (D-035), and draws exactly one snap for it (its appearance).
// - Every frame each client's store takes equals the server's (`frameDigest`); every snapshot the
//   match sends is a delta against the client's acked tick whenever that is usable (`DeltaWatch`);
//   the recorded clients reconcile every snapshot; no strike.

export const BOTS = 8;
/** The bot that leaves and whose slot the new client takes (a slot with players above it). */
export const REJOIN_SLOT = 3;
const PROFILE = "wan-100-loss1";

export interface LateJoinTimeline {
  readonly lateAtS: number;
  readonly reconnectAtS: number;
  readonly endS: number;
}

/** What one observer saw of the rejoined slot, from its newest stored frames and its remotes. */
class SlotWatch {
  /** Teleport counter of the slot in the newest frame before the leave. */
  before = -1;
  /** Seen absent in a newest frame after the leave; then present again with this counter. */
  sawAbsent = false;
  after = -1;
  /** Frames after the leave on which the interpolated slot was marked teleported (a snap). */
  snaps = 0;
  /** A present frame after the leave, before any absent one, with another counter (must not be). */
  changedWithoutRemoval = false;
}

export interface LateJoinRun {
  readonly h: MultiHarness;
  readonly watch: DeltaWatch;
  readonly late: HarnessClient;
  readonly left: HarnessClient;
  readonly rejoined: HarnessClient;
  readonly slots: Map<HarnessClient, SlotWatch>;
  /** Per client: whether its first stored frame was full, and the players it held. */
  readonly firstStored: Map<HarnessClient, { full: boolean; present: number }>;
  readonly timeline: LateJoinTimeline;
}

export function runLateJoin(timeline: LateJoinTimeline, seed: number): LateJoinRun {
  const h = new MultiHarness({ map: "arena_greybox", seed });
  const link = findNetProfile(PROFILE) as NetProfile;
  const watch = new DeltaWatch(h, ticksIn(2 * (link.delayMs + link.jitterMs) + 100));
  const slots = new Map<HarnessClient, SlotWatch>();
  const firstStored = new Map<HarnessClient, { full: boolean; present: number }>();
  let leftAt = -1;

  const onFrame = (c: HarnessClient): void => {
    const sim = c.client;
    const store = sim.store;
    if (!firstStored.has(c) && store.stored > 0) {
      firstStored.set(c, {
        full: store.full === store.stored,
        present: store.newest?.presentCount ?? 0,
      });
    }
    sim.updateRemotes();
    const w = slots.get(c);
    const f = store.newest;
    if (w === undefined || f === null || sim.connection.clientId === REJOIN_SLOT) return;
    const present = f.present[REJOIN_SLOT] === 1 && f.stamp[REJOIN_SLOT] !== 0;
    const seq = f.teleportSeq[REJOIN_SLOT] as number;
    if (leftAt < 0) {
      if (present) w.before = seq;
      return;
    }
    if (!present) {
      w.sawAbsent = true;
    } else if (!w.sawAbsent) {
      if (seq !== w.before) w.changedWithoutRemoval = true;
    } else if (w.after < 0) {
      w.after = seq;
    }
    if (sim.remotes.view.teleported[REJOIN_SLOT] === 1) w.snaps++;
  };

  const add = (i: number, record: boolean): HarnessClient => {
    const c = h.addClient({
      input: createBotInput("arena_greybox", i, seed),
      profile: link,
      frameIntervalMs: i % 2 === 0 ? FRAMES_BOT_TIMER : FRAMES_BROWSER_HITCHES,
      record,
      checkFrames: true,
      onFrame,
    });
    slots.set(c, new SlotWatch());
    return c;
  };

  // Client 0 is recorded (an observer that reconciles); the bots join 100 ms apart.
  for (let i = 0; i < BOTS; i++) {
    add(i, i === 0);
    h.run(100);
  }
  h.run(timeline.lateAtS * 1000 - h.now);
  const late = add(BOTS, true);
  h.run(timeline.reconnectAtS * 1000 - h.now);
  const left = h.clients[REJOIN_SLOT] as HarnessClient;
  left.leave();
  leftAt = h.now;
  h.runUntil(() => h.match.session(REJOIN_SLOT) === undefined, 2000, "the freed slot");
  const rejoined = add(BOTS + 1, true);
  h.run(timeline.endS * 1000 - h.now);
  return { h, watch, late, left, rejoined, slots, firstStored, timeline };
}

/** NET-12's pass conditions; returns the run's account for the log. */
export function expectLateJoin(run: LateJoinRun): string {
  const { h, watch, late, left, rejoined, slots, firstStored, timeline } = run;
  const account =
    `NET-12: ${BOTS} bots + a late joiner at ${timeline.lateAtS} s, slot ${REJOIN_SLOT} ` +
    `rejoined at ${timeline.reconnectAtS} s, ${timeline.endS} s on arena_greybox, ${PROFILE}: ` +
    `${watch.describe()}`;
  expect(watch.failures, account).toEqual([]);
  expect(watch.fullsWithBaseline).toBe(0);
  expect(watch.acksAhead).toBe(0);
  expect(watch.warmDeltaShare, account).toBeGreaterThanOrEqual(0.9);

  // A late joiner and a rejoined client start with a full snapshot listing every player.
  expect(late.session?.clientId).toBe(BOTS);
  expect(rejoined.session?.clientId).toBe(REJOIN_SLOT);
  expect(rejoined.session).not.toBe(left.session);
  for (const c of [late, rejoined]) {
    expect(firstStored.get(c), `client ${c.index}`).toEqual({ full: true, present: BOTS + 1 });
    expect(c.session?.stats.fullSnapshots, `client ${c.index}`).toBeGreaterThanOrEqual(1);
  }

  // Every observer saw the slot's player removed, then the new one with the next counter, and
  // drew one snap for it.
  let observers = 0;
  for (const [c, w] of slots) {
    if (c === left || c === rejoined) continue;
    observers++;
    expect(w.sawAbsent, `client ${c.index} saw the leave`).toBe(true);
    expect(w.changedWithoutRemoval, `client ${c.index}`).toBe(false);
    expect(w.after, `client ${c.index}`).toBe((w.before + 1) & 0xff);
    expect(w.snaps, `client ${c.index} snaps`).toBe(1);
  }
  expect(observers).toBe(BOTS);

  for (const c of h.clients) {
    const end = c === left ? "left" : "active";
    expect(c === left ? c.left : c.client.active, `client ${c.index} ${end}`).toBe(true);
    expect(c.digestMismatches, `client ${c.index}`).toEqual([]);
    expect(c.client.store.bad, `client ${c.index}`).toBe(0);
    expect(c.client.store.baselineDrops, `client ${c.index}`).toBe(0);
    expect(c.session?.stats.strikes, `client ${c.index}`).toBe(0);
    if (c.record) expect(c.unreconciled(), `client ${c.index}`).toEqual([]);
    if (c !== left) {
      const playedS = (h.now - c.joinedAt) / 1000;
      expect(c.digestsChecked, `client ${c.index}`).toBeGreaterThan(playedS * 60 * 0.7);
    }
  }
  expectNoStrikes(h.match, []);
  return account;
}
