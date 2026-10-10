import { MixedInput } from "@game/client/net";
import {
  ENTITY_NEW_BITS,
  findNetProfile,
  MAX_SNAPSHOT_BYTES,
  MSG_SNAPSHOT,
  type NetProfile,
  SNAP_FULL_FIXED_BITS,
} from "@game/shared";
import { expect } from "vitest";
import { createBotInput } from "../../src/bots/routes";
import { DeltaWatch, ticksIn } from "./deltaWatch";
import { expectNoStrikes } from "./honest";
import { FRAMES_BOT_TIMER } from "./interpolation";
import { FRAMES_BROWSER_HITCHES, type HarnessClient, MultiHarness } from "./multiHarness";

// NET-08 (a), shared by its two tiers (docs/05 §9.2, §14; M3 design §5, §6 increment 9; D-036,
// D-038): 16 bots and a human stand-in on arena_greybox at wan-100-loss1, through the real match.
// The bots run the bots' behaviours (3 in 5 strafe-jump the yard ring, the rest random-walk) on
// the bots' 60 Hz timer; the human stand-in plays `MixedInput` with browser hitches. Bandwidth is
// what each server session's socket would carry: payload plus WebSocket framing (the server's
// frames unmasked, the client's masked), KB = 1000 B (D-036). Once everyone is in, a window is
// measured: per client the average down ≤ 32 KB/s, the busiest second ≤ 48 KB/s, up ≤ 8 KB/s;
// every snapshot of the run ≤ 1100 B; the mean snapshot ≤ 0.7 × a full snapshot of the same
// frames; at most one full snapshot per second per client; deltas checked as NET-02 (b) checks
// them (`DeltaWatch`), never a missing baseline; and NET-04's prediction criteria for every
// client (under 1 correction/s, mean under 2 u), the fast tier's 16-client representative of
// NET-04. The fast tier measures 5 s, the long tier 60 s (the design's window).

export const BANDWIDTH_BOTS = 16;
const PLAYERS = BANDWIDTH_BOTS + 1;
const PROFILE = "wan-100-loss1";
/** docs/05 §9.2 (16 players): down and up per client, B/s; the busiest second (design). */
const DOWN_BUDGET = 32_000;
const DOWN_PEAK = 48_000;
const UP_BUDGET = 8_000;

interface ClientWindow {
  snapshots: number;
  snapshotBytes: number;
  fullEquivalentBytes: number;
  peakDown: number;
}

export interface BandwidthRun {
  readonly h: MultiHarness;
  readonly watch: DeltaWatch;
  readonly human: HarnessClient;
  readonly seconds: number;
  /** Per client: wire bytes down and up and full snapshots over the window. */
  readonly down: number[];
  readonly up: number[];
  readonly fulls: number[];
  readonly windows: ClientWindow[];
}

/**
 * `bots` bots (16 for NET-08 (a), 31 for the 32-player report (b)) join 100 ms apart, then the
 * human stand-in; once all are in, `seconds` are measured. The match keeps its default
 * `sv_maxClients` (32).
 */
export function runBandwidth(seconds: number, seed: number, bots = BANDWIDTH_BOTS): BandwidthRun {
  const h = new MultiHarness({ map: "arena_greybox", seed });
  const link = findNetProfile(PROFILE) as NetProfile;
  const watch = new DeltaWatch(h, ticksIn(2 * (link.delayMs + link.jitterMs) + 100));
  for (let i = 0; i < bots; i++) {
    h.addClient({
      input: createBotInput("arena_greybox", i, seed),
      profile: link,
      frameIntervalMs: FRAMES_BOT_TIMER,
    });
    h.run(bots > BANDWIDTH_BOTS ? 50 : 100);
  }
  const human = h.addClient({
    input: new MixedInput(),
    profile: link,
    frameIntervalMs: FRAMES_BROWSER_HITCHES,
    checkFrames: true,
  });
  h.runUntil(() => human.client.active, 3000, "the human stand-in in");
  h.run(1000);
  const clients = h.clients;
  expect(clients.every((c) => c.client.active)).toBe(true);

  const windows: ClientWindow[] = clients.map(() => ({
    snapshots: 0,
    snapshotBytes: 0,
    fullEquivalentBytes: 0,
    peakDown: 0,
  }));
  const watchTick = h.afterServerTick;
  h.afterServerTick = () => {
    watchTick?.();
    const t = h.match.serverTick;
    const frame = h.match.history.get(t);
    if (frame === null) return;
    const full = (SNAP_FULL_FIXED_BITS + (frame.presentCount - 1) * ENTITY_NEW_BITS + 7) >> 3;
    for (let i = 0; i < clients.length; i++) {
      const c = clients[i] as HarnessClient;
      if (c.tap.lastSnapshotTick !== t) continue;
      const w = windows[i] as ClientWindow;
      w.snapshots++;
      w.snapshotBytes += c.tap.lastSnapshotBytes;
      w.fullEquivalentBytes += full;
    }
  };
  const down0 = clients.map((c) => c.tap.down.wireBytes);
  const up0 = clients.map((c) => c.tap.up.wireBytes);
  const fulls0 = clients.map((c) => c.tap.fullSnapshots);
  for (let s = 0; s < seconds; s++) {
    const before = clients.map((c) => c.tap.down.wireBytes);
    h.run(1000);
    for (let i = 0; i < clients.length; i++) {
      const w = windows[i] as ClientWindow;
      const second = (clients[i] as HarnessClient).tap.down.wireBytes - (before[i] as number);
      w.peakDown = Math.max(w.peakDown, second);
    }
  }
  h.afterServerTick = watchTick;
  return {
    h,
    watch,
    human,
    seconds,
    down: clients.map((c, i) => c.tap.down.wireBytes - (down0[i] as number)),
    up: clients.map((c, i) => c.tap.up.wireBytes - (up0[i] as number)),
    fulls: clients.map((c, i) => c.tap.fullSnapshots - (fulls0[i] as number)),
    windows,
  };
}

/** NET-08 (a)'s pass conditions; returns the run's account for the log. */
export function expectBandwidth(run: BandwidthRun): string {
  const { h, watch, human, seconds, down, up, fulls, windows } = run;
  const clients = h.clients;
  expect(clients).toHaveLength(PLAYERS);
  const kb = (b: number) => (b / 1000).toFixed(2);
  const downRates = down.map((b) => b / seconds);
  const upRates = up.map((b) => b / seconds);
  let snaps = 0;
  let snapBytes = 0;
  let fullBytes = 0;
  for (const w of windows) {
    snaps += w.snapshots;
    snapBytes += w.snapshotBytes;
    fullBytes += w.fullEquivalentBytes;
  }
  const peak = Math.max(...windows.map((w) => w.peakDown));
  const largest = Math.max(...clients.map((c) => c.tap.down.maxByType[MSG_SNAPSHOT] as number));
  const correctionRates = clients.map(
    (c) => c.totals().corrections / ((h.now - c.joinedAt) / 1000),
  );
  const worstMean = Math.max(...clients.map((c) => c.totals().meanCorrection));
  const account =
    `NET-08 (a): ${BANDWIDTH_BOTS} bots + 1 human stand-in, arena_greybox, ${PROFILE}, ` +
    `${seconds} s window: down mean ${kb(mean(downRates))} KB/s, max ${kb(Math.max(...downRates))} ` +
    `KB/s, busiest second ${kb(peak)} KB; up max ${kb(Math.max(...upRates))} KB/s (payload + ` +
    `WebSocket framing, KB = 1000 B); snapshots mean ${(snapBytes / snaps).toFixed(0)} B vs ` +
    `${(fullBytes / snaps).toFixed(0)} B full (${((100 * snapBytes) / fullBytes).toFixed(0)}%), ` +
    `largest ${largest} B, the human's join ${human.tap.maxFullSnapshot} B; ` +
    `${fulls.reduce((a, b) => a + b, 0)} full in the window; corrections worst ` +
    `${Math.max(...correctionRates).toFixed(2)}/s (mean ≤ ${worstMean.toFixed(2)} u); ${watch.describe()}`;
  expect(watch.failures, account).toEqual([]);
  expect(watch.fullsWithBaseline).toBe(0);
  expect(watch.acksAhead).toBe(0);
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i] as HarnessClient;
    const w = windows[i] as ClientWindow;
    const who = `client ${i}: ${account}`;
    expect(downRates[i], who).toBeLessThanOrEqual(DOWN_BUDGET);
    expect(w.peakDown, who).toBeLessThanOrEqual(DOWN_PEAK);
    expect(upRates[i], who).toBeLessThanOrEqual(UP_BUDGET);
    expect(c.tap.down.maxByType[MSG_SNAPSHOT], who).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    expect(w.snapshotBytes, who).toBeLessThanOrEqual(0.7 * w.fullEquivalentBytes);
    expect(fulls[i], who).toBeLessThanOrEqual(seconds);
    expect(w.snapshots, who).toBeGreaterThan(seconds * 60 * 0.95);
    expect(c.session?.stats.strikes, who).toBe(0);
    expect(c.client.store.baselineDrops, who).toBe(0);
    // NET-04's prediction criteria hold for all 17 over deltas: under 1 correction/s, mean < 2 u.
    expect(correctionRates[i], who).toBeLessThan(1);
    expect(c.totals().meanCorrection, who).toBeLessThan(2);
  }
  expect(human.digestMismatches).toEqual([]);
  expect(human.digestsChecked).toBeGreaterThan(seconds * 60 * 0.7);
  // 86 + 199 + 7 + 16 × 213 bits: the human, last in, got every other player as a new body.
  expect(human.tap.maxFullSnapshot).toBe(463);
  expectNoStrikes(h.match, []);
  return account;
}

function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return xs.length === 0 ? 0 : s / xs.length;
}

/** The 32-player report's players: 31 bots and the human stand-in, the default `sv_maxClients`. */
export const REPORT_BOTS = 31;

/**
 * NET-08 (b)'s pass conditions (M3 design §5; D-036, D-046): 32 players, the default cap, where
 * the worst case always fits, so the byte-budget scheduler never runs: no size pass and no player
 * left out; every snapshot ≤ 1100 B; deltas as NET-02 (b) checks them. Bandwidth, sizes and the
 * delta share are reported, not gated (`docs/05` §9.2 budgets 16 players).
 */
export function expectReport32(run: BandwidthRun): string {
  const { h, watch, human, seconds, down, up, windows } = run;
  const clients = h.clients;
  const m = h.match.metrics;
  expect(clients).toHaveLength(REPORT_BOTS + 1);
  expect(h.match.maxClients).toBe(32);
  let snaps = 0;
  let snapBytes = 0;
  let fullBytes = 0;
  for (const w of windows) {
    snaps += w.snapshots;
    snapBytes += w.snapshotBytes;
    fullBytes += w.fullEquivalentBytes;
  }
  const kb = (b: number) => (b / 1000).toFixed(2);
  const downRates = down.map((b) => b / seconds);
  const largest = Math.max(...clients.map((c) => c.tap.down.maxByType[MSG_SNAPSHOT] as number));
  const account =
    `NET-08 (b): ${REPORT_BOTS} bots + 1 human stand-in (32 players), arena_greybox, ${PROFILE}, ` +
    `${seconds} s window: down mean ${kb(mean(downRates))} KB/s, max ${kb(Math.max(...downRates))} ` +
    `KB/s, up max ${kb(Math.max(...up.map((b) => b / seconds)))} KB/s; snapshots mean ` +
    `${(snapBytes / snaps).toFixed(0)} B vs ${(fullBytes / snaps).toFixed(0)} B full, largest ` +
    `${largest} B, the human's join ${human.tap.maxFullSnapshot} B; ${m.sizePasses} size passes, ` +
    `${m.deferredEntities} players left out; ${watch.describe()}`;
  expect(watch.failures, account).toEqual([]);
  expect(watch.acksAhead).toBe(0);
  expect(largest, account).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
  expect([m.sizePasses, m.deferredEntities, m.deferredSnapshots], account).toEqual([0, 0, 0]);
  // No mirror anywhere: none from the pool, none on a session (the design's heap check, by
  // construction: a mirror exists only through the pool).
  expect(h.match.mirrors.allocated, account).toBe(0);
  for (const c of clients) {
    expect(c.session?.mirror, account).toBeNull();
    expect(c.client.store.deferred, account).toBe(0);
    expect(c.client.store.baselineDrops, account).toBe(0);
    expect(c.session?.stats.strikes, account).toBe(0);
  }
  expect(human.digestMismatches).toEqual([]);
  // 86 + 199 + 7 + 31 × 213 bits: the human, last in, got every other player as a new body.
  expect(human.tap.maxFullSnapshot).toBe(862);
  return account;
}
