import {
  type CloseHandler,
  findNetProfile,
  MAX_UNRELIABLE_BYTES,
  type MessageHandler,
  MSG_INPUT,
  type NetProfile,
  type Transport,
  type TransportStats,
} from "@game/shared";
import { expect } from "vitest";
import { createBotInput } from "../../src/bots/routes";
import { DeltaWatch, ticksIn } from "./deltaWatch";
import { expectNoStrikes } from "./honest";
import {
  FRAMES_144HZ,
  FRAMES_BROWSER_HITCHES,
  type HarnessClient,
  MultiHarness,
} from "./multiHarness";

// NET-02 (b), shared by its two tiers (M3 design §5, §6 increment 9; D-038): the real match and 4
// real clients on arena_greybox at bad-250-loss5 (loss, duplicates, reordering, 250 ms RTT), the
// bots' behaviours (routes and random walks), joining 250 ms apart. Every snapshot the match
// sends is watched (`DeltaWatch`: baseBack = T − ackTick whenever the acked tick is a usable
// baseline, full otherwise, with the ack derived apart from the match; each record within its
// full form + 20 bits), and every frame each client stores is checked against the frame the
// server encoded it from (`frameDigest`). One client's acks freeze for 1.5 s (`AckFreeze`), so its
// baseline grows old (baseBack 32–63), ages out of the window (full snapshots) and comes back
// once its acks move again. The fast tier runs 15 s, the long one 60 s.

export const DELTA_MATCH_CLIENTS = 4;
const PROFILE = "bad-250-loss5";
/** The client whose acks freeze, and when (ms of the run). */
const FROZEN = 1;
const FREEZE_FROM_MS = 4000;
const FREEZE_MS = 1500;

/**
 * Between the client and its link: while `frozen`, every INPUT carries the ack (lastSnapshotTick,
 * bytes 3–6, low 16 bits first; docs/05 §3.6) of the first INPUT sent after the freeze began, as
 * if the client's store stopped taking frames while its cmds still flowed.
 */
class AckFreeze implements Transport {
  frozen = false;
  private ack: number[] | null = null;
  private readonly copy = new Uint8Array(MAX_UNRELIABLE_BYTES);

  constructor(private readonly inner: Transport) {}

  sendUnreliable(d: Uint8Array, len: number): void {
    if (!this.frozen) this.ack = null;
    if (!this.frozen || len < 7 || d[0] !== MSG_INPUT) {
      this.inner.sendUnreliable(d, len);
      return;
    }
    const b = this.copy;
    b.set(d.subarray(0, len));
    if (this.ack === null) this.ack = [b[3] ?? 0, b[4] ?? 0, b[5] ?? 0, b[6] ?? 0];
    b.set(this.ack, 3);
    this.inner.sendUnreliable(b, len);
  }

  sendReliable(d: Uint8Array, len: number): void {
    this.inner.sendReliable(d, len);
  }

  onMessage(cb: MessageHandler): void {
    this.inner.onMessage(cb);
  }

  onClose(cb: CloseHandler): void {
    this.inner.onClose(cb);
  }

  poll(): void {
    this.inner.poll();
  }

  close(reason?: string): void {
    this.inner.close(reason);
  }

  isOpen(): boolean {
    return this.inner.isOpen();
  }

  stats(): TransportStats {
    return this.inner.stats();
  }
}

export interface DeltaMatchRun {
  readonly h: MultiHarness;
  readonly watch: DeltaWatch;
  readonly seconds: number;
  /** The frozen client's full snapshots before, during and after its freeze (+ 1 s). */
  readonly frozenFulls: readonly [number, number, number];
}

export function runDeltaMatch(seconds: number, seed: number): DeltaMatchRun {
  const h = new MultiHarness({ map: "arena_greybox", seed });
  const link = findNetProfile(PROFILE) as NetProfile;
  // Past the first RTT after READY (2 × (125 + 40) ms at worst) no ack has an excuse to be missing.
  const watch = new DeltaWatch(h, ticksIn(2 * (link.delayMs + link.jitterMs) + 100));
  let freeze: AckFreeze | null = null;
  for (let i = 0; i < DELTA_MATCH_CLIENTS; i++) {
    h.addClient({
      input: createBotInput("arena_greybox", i, seed),
      profile: link,
      frameIntervalMs: i % 2 === 0 ? FRAMES_144HZ : FRAMES_BROWSER_HITCHES,
      record: true,
      wrap:
        i === FROZEN
          ? (t) => {
              freeze = new AckFreeze(t);
              return freeze;
            }
          : undefined,
    });
    h.run(250);
  }
  const frozen = h.clients[FROZEN] as HarnessClient;
  const gate = freeze as AckFreeze | null;
  if (gate === null) throw new Error("no AckFreeze");
  h.run(FREEZE_FROM_MS - h.now);
  const before = frozen.tap.fullSnapshots;
  gate.frozen = true;
  h.run(FREEZE_MS);
  gate.frozen = false;
  const during = frozen.tap.fullSnapshots;
  h.run(1000);
  const after = frozen.tap.fullSnapshots;
  h.run(seconds * 1000 - h.now);
  return { h, watch, seconds, frozenFulls: [before, during - before, after - during] };
}

/** NET-02 (b)'s pass conditions; returns the run's account for the log. */
export function expectDeltaMatch(run: DeltaMatchRun): string {
  const { h, watch, seconds } = run;
  let drops = 0;
  let checked = 0;
  let stored = 0;
  for (const c of h.clients as HarnessClient[]) {
    const store = c.client.store;
    expect(c.client.active, `client ${c.index}`).toBe(true);
    expect(c.digestMismatches, `client ${c.index}`).toEqual([]);
    expect(c.unreconciled(), `client ${c.index}`).toEqual([]);
    expect(store.bad, `client ${c.index}`).toBe(0);
    // Each client acks only frames it stored, and the server codes only against acked ticks
    // within the 64-frame rings: never a decode against a missing baseline (D-038). Only the
    // frozen client may miss a few: deltas against its frozen ack 61–63 ticks back that arrive
    // after the full snapshot 64 ticks on, which took the baseline's ring slot (jitter reorders).
    if (c.index === FROZEN) expect(store.baselineDrops).toBeLessThanOrEqual(5);
    else expect(store.baselineDrops, `client ${c.index}`).toBe(0);
    expect(c.session?.stats.strikes, `client ${c.index}`).toBe(0);
    // The link really was impaired.
    expect(c.sim?.stats().lost, `client ${c.index}`).toBeGreaterThan(0);
    drops += store.baselineDrops;
    checked += c.digestsChecked;
    stored += store.stored;
  }
  const account =
    `NET-02 (b): ${DELTA_MATCH_CLIENTS} clients, arena_greybox, ${PROFILE}, ${seconds} s: ` +
    `${watch.describe()}; ${checked} stored frames checked, ${drops} baseline drops`;
  expect(watch.failures, account).toEqual([]);
  expect(watch.fullsWithBaseline).toBe(0);
  expect(watch.acksAhead).toBe(0);
  // Every client frame the store took matched the server's (most were checked: the rest were
  // overwritten in the ring before the client's next frame looked).
  expect(checked, account).toBeGreaterThan(stored * 0.9);
  expect(checked, account).toBeGreaterThan(DELTA_MATCH_CLIENTS * seconds * 60 * 0.7);
  // Deltas are actually used: ≥ 90% of the snapshots after each client's first RTT.
  expect(watch.warmDeltaShare, account).toBeGreaterThanOrEqual(0.9);
  expect(watch.worstEntityOver, account).toBeLessThanOrEqual(20);
  expect(watch.worstLocalOver, account).toBeLessThanOrEqual(20);
  expect(watch.deltaBytes / watch.deltas, account).toBeLessThanOrEqual(
    watch.fullEquivalentBytes / watch.deltas,
  );
  // The frozen client's baseline grew old, aged out and came back: deltas 32–63 ticks back, full
  // snapshots once the frozen ack was 64 back, until about an RTT after the acks moved again
  // (then deltas; before the freeze only its join's were full).
  const [before, during, after] = run.frozenFulls;
  const frozen = h.clients[FROZEN] as HarnessClient;
  const freezeAccount = `${account}; frozen client: fulls ${before} / ${during} / ${after}`;
  expect(watch.maxBaseBack, freezeAccount).toBe(63);
  expect(watch.oldDeltas, freezeAccount).toBeGreaterThanOrEqual(32);
  expect(during, freezeAccount).toBeGreaterThanOrEqual(10);
  expect(after, freezeAccount).toBeGreaterThan(0);
  expect(after, freezeAccount).toBeLessThanOrEqual(30);
  expect(frozen.tap.lastBaseBack, freezeAccount).toBeGreaterThan(0);
  expectNoStrikes(h.match, []);
  return freezeAccount;
}
