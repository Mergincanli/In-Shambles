import { STAT_RENDER_SNAPS } from "@game/client/net";
import {
  MATCH_MAX_CLIENTS,
  MAX_SNAPSHOT_BYTES,
  MSG_SNAPSHOT,
  Mulberry32,
  quantizePlayerState,
  SNAP_MAX_STALENESS,
} from "@game/shared";
import { expect } from "vitest";
import { createBotInput } from "../../src/bots/routes";
import { DeltaWatch, ticksIn } from "./deltaWatch";
import { expectSmooth, profile, RemoteWatch } from "./interpolation";
import { type FrameModel, type HarnessClient, MultiHarness } from "./multiHarness";

// NET-02 (c) and NET-05's 64-player leg (docs/05 §4.3, §14; M3 design §5, D-046), shared by the
// tiers: the real match with `sv_maxClients` 64 and 64 real clients on arena_greybox running the
// bots' behaviours (routes and random walks), so the byte-budget scheduler runs at the real
// 1100 B budget. Every snapshot is watched (`DeltaWatch`: baseBack = T − ackTick, ≤ 1100 B, nobody
// left out twice in a row, removals never deferred, a reused slot never showing the departed
// player, pending only over a baseline without state) and every frame the frame-checking clients
// store is compared with what the server sent them, stamps and pending slots included
// (`frameDigest` of `sentFrame`). The storm respawns and launches players every tick, rotating
// (STORM_RESPAWNS), so most snapshots must leave players out. Observers sample their
// interpolation of all 63 others at 60 Hz with NET-05's checks; a late joiner can come in at 64.

/** Frames like a 60 Hz timer with jitter (every client: 64 at 144 Hz cost too much CPU). */
export const FRAMES_60HZ: FrameModel = (rng) => 1000 / 60 + (rng.nextFloat() * 2 - 1);

/**
 * The storm (M3 design §5 NET-02 (c), test values): this many respawns per tick, rotating (each
 * player every 5–6 ticks), each launched from its spawn point at up to this speed per axis (u/s).
 * Plain respawns do not force deferral: the players restart still at 16 spawn points, so their
 * records shrink (24 per tick left players out of 1% of the snapshots); launched, every record
 * changes all its fields at their absolute classes, and 12 per tick leave players out of about
 * 90% (24 per tick about 50%: the players spend less time in flight between respawns).
 */
export const STORM_RESPAWNS = 12;
export const STORM_LAUNCH_SPEED = 2400;

export interface SixtyFourOptions {
  readonly profile: string;
  /** Measured after every client is in. */
  readonly seconds: number;
  readonly seed: number;
  /** Respawn and launch STORM_RESPAWNS players per tick, rotating, through the window. */
  readonly storm?: boolean;
  /** Clients (from index 1) whose remotes are watched with NET-05's checks. */
  readonly observers?: number;
  /** Clients whose every stored frame is checked against the server's (default all 64). */
  readonly checked?: number;
  /** The 64th client joins only after `lateJoinMs` of the window (NET-05's late joiner). */
  readonly lateJoinMs?: number;
}

export interface SixtyFourRun {
  readonly h: MultiHarness;
  readonly watch: DeltaWatch;
  readonly watches: RemoteWatch[];
  readonly options: SixtyFourOptions;
  readonly late: HarnessClient | null;
  /** The late joiner's watch, when there is one. */
  readonly lateWatch: RemoteWatch | null;
  /** Over the measured window (joins excluded): snapshots sent and those that left anyone out. */
  readonly windowSnapshots: number;
  readonly windowDeferred: number;
}

export function runSixtyFour(o: SixtyFourOptions): SixtyFourRun {
  const h = new MultiHarness({ map: "arena_greybox", seed: o.seed, maxClients: MATCH_MAX_CLIENTS });
  const link = profile(o.profile);
  const watch = new DeltaWatch(h, ticksIn(2 * (link.delayMs + link.jitterMs) + 100));
  const watches: RemoteWatch[] = [];
  const observers = o.observers ?? 0;
  const checked = o.checked ?? MATCH_MAX_CLIENTS;
  let lateWatch: RemoteWatch | null = null;
  const add = (i: number, watched: boolean): HarnessClient => {
    let w: RemoteWatch | null = null;
    const c = h.addClient({
      input: createBotInput("arena_greybox", i, o.seed),
      profile: link,
      frameIntervalMs: FRAMES_60HZ,
      checkFrames: i < checked,
      onFrame: watched ? () => w?.sample() : undefined,
    });
    if (watched) {
      w = new RemoteWatch(
        c.client,
        c.client.world,
        () => null,
        () => h.now,
      );
      watches.push(w);
    }
    return c;
  };
  const lateJoin = o.lateJoinMs !== undefined;
  const first = lateJoin ? MATCH_MAX_CLIENTS - 1 : MATCH_MAX_CLIENTS;
  for (let i = 0; i < first; i++) {
    add(i, i >= 1 && i <= observers);
    h.run(20);
  }
  h.runUntil(() => h.clients.every((c) => c.client.active), 5000, "every client in");
  h.run(500);
  if (o.storm === true) {
    let next = 0;
    const rng = new Mulberry32((o.seed ^ 0x5707) >>> 0);
    const launch = (max: number) =>
      (rng.nextInt(2) === 0 ? -1 : 1) * (max / 2 + rng.nextFloat() * (max / 2));
    h.beforeServerTick = () => {
      for (let k = 0; k < STORM_RESPAWNS; k++) {
        const s = h.match.session(next);
        next = (next + 1) % MATCH_MAX_CLIENTS;
        if (s === undefined || !h.match.respawn(s)) continue;
        // Launched from the spawn point (as a jump pad or a blast would): its record then
        // changes every field at its absolute class, the scheduler's worst case.
        const v = s.player.velocity;
        v[0] = launch(STORM_LAUNCH_SPEED);
        v[1] = launch(STORM_LAUNCH_SPEED);
        v[2] = STORM_LAUNCH_SPEED / 2 + rng.nextFloat() * (STORM_LAUNCH_SPEED / 2);
        quantizePlayerState(s.player);
      }
    };
  }
  const m = h.match.metrics;
  const snapshots0 = m.snapshots;
  const deferred0 = m.deferredSnapshots;
  let late: HarnessClient | null = null;
  if (lateJoin) {
    h.run(o.lateJoinMs ?? 0);
    late = add(MATCH_MAX_CLIENTS - 1, true);
    lateWatch = watches[watches.length - 1] ?? null;
    h.run(o.seconds * 1000 - (o.lateJoinMs ?? 0));
  } else {
    h.run(o.seconds * 1000);
  }
  h.beforeServerTick = null;
  return {
    h,
    watch,
    watches,
    options: o,
    late,
    lateWatch,
    windowSnapshots: m.snapshots - snapshots0,
    windowDeferred: m.deferredSnapshots - deferred0,
  };
}

/** NET-02 (c)'s pass conditions; returns the run's account for the log. */
export function expectSixtyFour(run: SixtyFourRun): string {
  const { h, watch, options } = run;
  const m = h.match.metrics;
  let checkedFrames = 0;
  let largest = 0;
  for (const c of h.clients) {
    const who = `client ${c.index}`;
    expect(c.client.active, who).toBe(true);
    expect(c.digestMismatches, who).toEqual([]);
    expect(c.client.store.bad, who).toBe(0);
    expect(c.client.store.baselineDrops, who).toBe(0);
    expect(c.session?.stats.strikes, who).toBe(0);
    largest = Math.max(largest, c.tap.down.maxByType[MSG_SNAPSHOT] as number);
    checkedFrames += c.digestsChecked;
  }
  const account =
    `NET-02 (c): 64 players, arena_greybox, ${options.profile}${options.storm ? ", respawn storm" : ""}, ` +
    `${options.seconds} s: ${watch.describe()}; server: ${m.sizePasses} size passes, ` +
    `${m.deferredSnapshots} deferring snapshots (${((100 * m.deferredSnapshots) / m.snapshots).toFixed(1)}%), ` +
    `${m.deferredEntities} left out, max staleness ${m.maxStaleness}, overflow ${m.snapshotOverflow}, ` +
    `overrun ${m.schedOverrun}; in the window ${((100 * run.windowDeferred) / run.windowSnapshots).toFixed(1)}% ` +
    `of ${run.windowSnapshots} snapshots left players out; largest snapshot ${largest} B; ` +
    `${checkedFrames} stored frames checked`;
  expect(h.clients).toHaveLength(MATCH_MAX_CLIENTS);
  expect(watch.failures, account).toEqual([]);
  expect(watch.fullsWithBaseline, account).toBe(0);
  expect(watch.acksAhead, account).toBe(0);
  expect(largest, account).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
  expect([m.snapshotOverflow, m.schedOverrun], account).toEqual([0, 0]);
  expect(m.maxStaleness, account).toBeLessThanOrEqual(SNAP_MAX_STALENESS);
  // The match's scheduler counters against the watch's own count of what was sent: the watch
  // sees every snapshot from the first join on, as the counters do.
  expect([m.snapshots, m.deferredSnapshots, m.deferredEntities], account).toEqual([
    watch.snapshots,
    watch.deferredSnapshots,
    watch.deferredPlayers,
  ]);
  expect(m.sizePasses, account).toBeGreaterThanOrEqual(m.deferredSnapshots);
  expect(m.sizePasses, account).toBeGreaterThan(0);
  expect(m.strikes, account).toBe(0);
  expect(m.rateLimited, account).toBe(0);
  expect(m.kicks, account).toBe(0);
  expect(watch.warmDeltaShare, account).toBeGreaterThanOrEqual(0.9);
  expect(checkedFrames, account).toBeGreaterThan(0);
  if (options.storm === true) {
    expect(run.windowDeferred / run.windowSnapshots, account).toBeGreaterThanOrEqual(0.5);
    expect(m.maxStaleness, account).toBe(SNAP_MAX_STALENESS);
  }
  return account;
}

/**
 * NET-05's checks on the 64-player observers (M3 design §5): the step criterion, no render snap
 * after the first, the delay within 2–6 and never below its formula (defer lag included), every
 * observer drawing all 63 others at the end and never hiding one the newest stored frame holds
 * (a deferred or pending remote is never hidden), and extrapolated + held ≤ 2% of the
 * remote-frames, storm included (its respawns do not make remotes extrapolate or hold: measured
 * 0.00%, so no frames need exempting). The late joiner received deferred snapshots, and its
 * remotes snap only when they first appear: once per slot, never on a later re-sent "new".
 */
export function expectSixtyFourSmooth(run: SixtyFourRun): string {
  const lines: string[] = [];
  let remoteFrames = 0;
  let held = 0;
  for (const w of run.watches) {
    expectSmooth(w);
    expect(w.client.remotes.view.count, w.summary("count")).toBe(MATCH_MAX_CLIENTS - 1);
    expect(w.hiddenPresent, w.summary("hidden while present")).toBe(0);
    expect(w.client.stats.totals[STAT_RENDER_SNAPS]).toBe(0);
    remoteFrames += w.remoteFrames;
    held += w.extrapolated + w.held;
    lines.push(w.summary(`observer ${w.client.connection.clientId}`));
  }
  const share = remoteFrames === 0 ? 0 : held / remoteFrames;
  expect(share, lines.join("\n")).toBeLessThanOrEqual(0.02);
  const lw = run.lateWatch;
  if (lw !== null && run.late !== null) {
    expect(
      run.late.client.store.deferredSnapshots,
      "late joiner's deferring snapshots",
    ).toBeGreaterThan(0);
    for (let s = 0; s < MATCH_MAX_CLIENTS; s++) {
      if (lw.drawn[s] === 0) continue;
      expect(lw.teleports[s], `late joiner, slot ${s}`).toBe(1);
    }
  }
  return (
    `NET-05 64 players${run.options.storm ? " (storm)" : ""}: ${remoteFrames} remote-frames, ` +
    `${(100 * share).toFixed(2)}% extrapolated or held; ${lines.join("; ")}`
  );
}
