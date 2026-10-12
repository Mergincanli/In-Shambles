import {
  MAX_ADAPTIVE_TICKS,
  MixedInput,
  SNAPSHOT_CORRECTED,
  STAT_CORRECTIONS,
  STAT_STARVED,
  STAT_STARVED_CORRECTIONS,
  StrafeCircuit,
} from "@game/client/net";
import {
  BitReader,
  type CloseHandler,
  decodeSnapshotHeader,
  type MessageHandler,
  MSG_INPUT,
  MSG_SNAPSHOT,
  NET_PROFILES,
  SNAP_FLAG_STARVED,
  SnapshotHeader,
  type Transport,
  type TransportStats,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { NetHarness } from "./harness";
import { expectNoStrikes } from "./honest";
import { setHarnessPrimerDefault } from "./multiHarness";
import {
  BROWSER_LIKE_CASES,
  browserLikeCase,
  bufferMean,
  expectCircuit,
  expectConverged,
  LOSSY_CASES,
  lossyCase,
  profile,
  run,
  SEED,
  worstStep,
} from "./reconciliation";

// NET-04, the M2 basic version (docs/05 §14, M2 design §5): the automated stand-in for "smooth at
// net_profile wan-150-loss2". The NET-03 harness drives the StrafeCircuit bot (laps of a square on
// movement_lab, strafe-jumping well past the run cap) for 60 s on every docs/10 §3 profile,
// through NetSim with a fixed seed:
// - lan and wan-50: 0 corrections;
// - wan-100-loss1 and wan-150-loss2: under 1 correction per second, mean under 2 u, render offset
//   never 8 u or more, and no frame-to-frame jump in the drawn position (each step at most
//   speed × frame time × 1.5 + 0.5 u);
// - bad-250-loss5: converges (no hard resync, laps go on, the buffer settles) and logs every
//   correction;
// - browser-like frame timing (60 fps with 15% of the frames 50–80 ms, or every frame 33–83 ms,
//   50–83 ms or, since D-039's cap/hitch trial, 83–125 ms) on wan-50, wan-100-loss1 and
//   wan-150-loss2, from the start or turning bad mid-circuit: the same bounds as the lossy
//   profiles for the corrections' render offset, the clock's own steps gliding (under
//   cl_teleportDist) and rare, and the buffer's latency bounded (D-028's adaptive input buffer);
//   with 60 fps hitches and 33–83 ms frames, after 20 s of learning, at most one fast-forward and
//   no slow-down while a dip below the target is in the clock's 90-snapshot window (D-039).
// Re-baselined under D-039's dilation (M3 increment 11): the round-trip step test expects a
// fast-forward up and dilation, not a hold, back down.
// On every profile the prediction converges: at each snapshot the client reconciled with, its
// standing prediction equals the server's recorded state (`NetHarness.unreconciled`), so a
// predictor that stopped correcting fails here, not only in its unit tests.
// - wan-100-loss1 with every snapshot of a starved tick lost (D-050): each starve still counts and
//   its correction is a starved one, on the next snapshot, which carries no STARVED flag: no
//   misprediction, where the one-snapshot flag called every one of them a misprediction.
// One summary line per profile is printed. The full NET-04 (16 bots, every mechanic) comes with M3.
// Tiers (D-032): this file runs one NetSim seed per profile and one browser-like case
// (wan-100-loss1, browser hitches, seed 1) in `pnpm test`; the other lossy seeds, the other
// browser-like cases, the onset runs and lan with 60 fps hitches run in `pnpm test:long`
// (`packages/tools/long/net-04-reconciliation.long.ts`). The runs and checks are shared
// (`reconciliation.ts`); `pnpm test:net` runs both tiers.

// This file's checks are logical, so it skips the pmove primer to keep D-032's budget; NET-03,
// NET-09 and the long tier run with it (D-040, reading 8).
setHarnessPrimerDefault(false);

describe("NET-04 (M2 basic): reconciliation on every profile", () => {
  it("covers every docs/10 §3 profile", () => {
    expect(NET_PROFILES.map((p) => p.name)).toEqual([
      "lan",
      "wan-50",
      "wan-100-loss1",
      "wan-150-loss2",
      "bad-250-loss5",
    ]);
  });

  it.each(["lan", "wan-50"])("%s: a 60 s strafe-jump circuit needs 0 corrections", (name) => {
    const h = run(profile(name));
    expectCircuit(h);
    expectConverged(h);
    const t = h.totals();
    expect(t.corrections).toBe(0);
    expect(t.hardResyncs).toBe(0);
    expect(Math.max(...h.frames.offset)).toBe(0);
    expect(worstStep(h.frames)).toBeLessThanOrEqual(1);
    // Steady frames on a clean link: the adaptive buffer adds nothing (D-028).
    expect(t.starved).toBe(0);
    expect(bufferMean(h.frames)).toBeLessThanOrEqual(h.client.settings.inputBuffer + 0.5);
  });

  it.each(LOSSY_CASES.filter(([, seed]) => seed === SEED))(
    "%s, seed %i: corrections rare and small, no visible rubber-banding",
    lossyCase,
  );

  it("bad-250-loss5: converges and logs its corrections", () => {
    // Seed 16: the adaptive buffer and dilation cover nearly all of this link's jitter (since the
    // server's EVENTS, D-043, whose reliable messages take jitter draws of the link's generator
    // too: 0 corrections a minute on seeds 1–15 and 17–20, 2 on this one; before EVENTS 0 or 1
    // over seeds 1–12, before dilation 0 to 3), so the correction path runs.
    const h = run(profile("bad-250-loss5"), 16);
    expectCircuit(h);
    expectConverged(h);
    const t = h.totals();
    // The link is bad enough that the correction path runs.
    expect(t.corrections).toBeGreaterThan(0);
    const c = h.client;
    expect(t.hardResyncs).toBe(0);
    // The buffer settles: the low edge at the margin or above (cl_inputBuffer − 1), the mean above
    // it by the link's spread (±40 ms of jitter, about 5 ticks), within the adaptive cap.
    expect(c.clock.bufferLow).toBeGreaterThanOrEqual(c.settings.inputBuffer - 1);
    expect(c.clock.bufferHealth).toBeLessThan(c.settings.inputBuffer + MAX_ADAPTIVE_TICKS);
    const log = c.predictor.corrections;
    expect(log.total).toBe(t.corrections);
    for (let i = 0; i < log.count; i++) {
      const r = log.at(i);
      expect(r.diff().length, `correction at tick ${r.tick}`).toBeGreaterThan(0);
      expect(r.latestTick).toBeGreaterThanOrEqual(r.tick);
    }
    if (log.count > 0) {
      const r = log.at(log.count - 1);
      console.log(`NET-04 bad-250-loss5 last correction, tick ${r.tick}: ${r.diff().join(", ")}`);
    }
  });

  it("a round-trip step up fast-forwards, a step down is dilated back without a hold (D-039; NET-07 measures both)", () => {
    const h = new NetHarness({ input: new StrafeCircuit(), profile: profile("wan-50"), seed: 3 });
    h.runTicks(600);
    const c = h.client;
    const clock = c.clock;
    const target = c.settings.inputBuffer;
    // The lead over the server's tick is the uplink delay plus the buffer, measured from the
    // server's side rather than from the clock's own EWMA.
    const lead0 = h.lead();
    expect(lead0).toBeGreaterThanOrEqual(target + 1);
    // 100 ms more round trip: the buffer runs dry, the server starves, the clock fast-forwards
    // to target − 1 and dilation closes the last tick.
    h.sim?.setProfile(profile("wan-150-loss2"));
    h.run(4000);
    const up = h.totals();
    expect(clock.fastForwards).toBeGreaterThanOrEqual(1);
    expect(clock.holds).toBe(0);
    expect(clock.bufferHealth).toBeGreaterThan(target - 1.5);
    h.run(4000);
    expect(h.totals().corrections - up.corrections).toBeLessThanOrEqual(4);
    const leadUp = h.lead();
    expect(leadUp - lead0).toBeGreaterThanOrEqual(2);
    // Back to lan: inputs arrive 75 ms early, about 5 ticks, under the hold threshold (target +
    // 6): once the window is clear of the old lows the clock slows down at up to 3% and the lead
    // shrinks to the buffer, with no hold.
    h.sim?.setProfile(profile("lan"));
    let slowed = false;
    for (let ms = 0; ms < 6000; ms += 100) {
      h.run(100);
      if (clock.dilation < 0) slowed = true;
    }
    expect(slowed).toBe(true);
    expect(clock.holds).toBe(0);
    expect(h.totals().clockAdjustments).toBe(clock.fastForwards);
    expect(clock.bufferHealth).toBeLessThan(target + 1);
    const leadLan = h.lead();
    expect(leadUp - leadLan).toBeGreaterThanOrEqual(3);
    expect(leadLan).toBeGreaterThanOrEqual(target);
    expect(leadLan).toBeLessThanOrEqual(target + 1);
    expect(h.totals().hardResyncs).toBe(0);
    expect(h.unreconciled()).toEqual([]);
  });

  it.each([
    ["wan-50", 250, 16],
    ["wan-100-loss1", 120, 8],
  ] as const)(
    "%s: a %i ms frame hitch is caught up, not dropped (at most %i corrections)",
    (name, ms, bound) => {
      // The client's tick follows the server's clock: the ticks a hitch owes run in the next frames
      // (5 a frame), so the server starves only for the hitch itself, not until a clock step.
      const h = new NetHarness({ input: new MixedInput(), profile: profile(name), seed: 1 });
      h.runTicks(600);
      const before = h.totals();
      const lead = h.lead();
      h.hitch(ms);
      h.run(3000);
      const after = h.totals();
      expect(after.corrections - before.corrections).toBeLessThanOrEqual(bound);
      expect(after.hardResyncs).toBe(0);
      expect(after.clockAdjustments - before.clockAdjustments).toBeLessThanOrEqual(1);
      // No lead lost to the hitch (a fast-forward may have added a little).
      expect(h.lead()).toBeGreaterThanOrEqual(lead - 1);
      expect(h.unreconciled()).toEqual([]);
    },
  );
});

/**
 * The client's end of the link after NetSim (D-050's case): loses `dropInputs` INPUTs from when it
 * is set (the cmds only they carry starve), and every SNAPSHOT flagged STARVED, whose ticks it
 * keeps in `lost`.
 */
class StarvedSnapshotsLost implements Transport {
  dropInputs = 0;
  readonly lost: number[] = [];
  private readonly reader = new BitReader();
  private readonly header = new SnapshotHeader();
  constructor(private readonly inner: Transport) {}
  sendUnreliable(d: Uint8Array, len: number): void {
    if (d[0] === MSG_INPUT && this.dropInputs > 0) this.dropInputs--;
    else this.inner.sendUnreliable(d, len);
  }
  sendReliable(d: Uint8Array, len: number): void {
    this.inner.sendReliable(d, len);
  }
  onMessage(cb: MessageHandler): void {
    this.inner.onMessage((d, len, reliable) => {
      if (!reliable && d[0] === MSG_SNAPSHOT) {
        const r = this.reader;
        r.reset(d, len);
        const h = this.header;
        if (decodeSnapshotHeader(r, h) && (h.flags & SNAP_FLAG_STARVED) !== 0) {
          this.lost.push(h.serverTick);
          return;
        }
      }
      cb(d, len, reliable);
    });
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

describe("NET-04: starves whose snapshots are lost (D-050)", () => {
  it("wan-100-loss1: every starve counts and every correction is a starved one, no misprediction", () => {
    // The M3 CI load job's failure: the snapshot of a starved tick lost (1% here), so the starve's
    // correction lands on the next snapshot, without the flag, and counted as a misprediction.
    // Here every flagged snapshot is lost, and bursts of 6 lost INPUTs (each losing the 3 cmds only
    // they carried) make the server starve 3 ticks a burst, plus what the profile's loss starves.
    let link: StarvedSnapshotsLost | null = null;
    const h = new NetHarness({
      input: new StrafeCircuit(),
      profile: profile("wan-100-loss1"),
      seed: SEED,
      wrap: (t) => {
        link = new StarvedSnapshotsLost(t);
        return link;
      },
    });
    const tap = link as unknown as StarvedSnapshotsLost;
    h.runTicks(600);
    const t = h.client.stats.totals;
    const p = h.client.predictor;
    const inner = p.onSnapshot.bind(p);
    const corrected: number[] = [];
    p.onSnapshot = (tick, s, hash16, teleportSeq) => {
      const result = inner(tick, s, hash16, teleportSeq);
      if (result === SNAPSHOT_CORRECTED) corrected.push(tick);
      return result;
    };
    const starvedFrom = h.serverStarved.length;
    const lostFrom = tap.lost.length;
    const before = [t[STAT_STARVED], t[STAT_CORRECTIONS], t[STAT_STARVED_CORRECTIONS]] as number[];
    for (let i = 0; i < 8; i++) {
      tap.dropInputs = 6;
      h.run(1000);
    }
    h.run(1000);
    const starves = h.serverStarved.slice(starvedFrom);
    const lost = tap.lost.slice(lostFrom);
    const starved = (t[STAT_STARVED] as number) - (before[0] as number);
    const corrections = (t[STAT_CORRECTIONS] as number) - (before[1] as number);
    const starvedCorrections = (t[STAT_STARVED_CORRECTIONS] as number) - (before[2] as number);
    console.log(
      `NET-04 starved snapshots lost: ${starves.length} starves (${lost.length} flagged snapshots ` +
        `lost here, the rest by the profile), ${corrections} corrections, ${starvedCorrections} ` +
        `starved, ${starved} starves counted`,
    );
    expect(starves.length).toBeGreaterThanOrEqual(8 * 3);
    // No flagged snapshot reached the client: the profile lost some before the tap saw them.
    for (const tick of lost) expect(starves).toContain(tick);
    // Every starve counted, though none of their snapshots arrived.
    expect(starved).toBe(starves.length);
    // Corrections on snapshots without the flag, each one excused by the counter: 0 mispredictions
    // (the one-snapshot flag would have reported all of them).
    expect(corrections).toBeGreaterThan(0);
    expect(corrected.length).toBe(corrections);
    for (const tick of corrected) expect(starves, `tick ${tick}`).not.toContain(tick);
    expect(corrections - starvedCorrections).toBe(0);
    expect(t[STAT_CORRECTIONS] as number).toBe(t[STAT_STARVED_CORRECTIONS] as number);
    expect(h.totals().hardResyncs).toBe(0);
    expect(h.unreconciled()).toEqual([]);
    expectNoStrikes(h.match, [h.client]);
  });
});

describe("NET-04 (M2 basic): browser-like frame timing", () => {
  it.each(
    BROWSER_LIKE_CASES.filter(
      ([name, model, seed]) =>
        name === "wan-100-loss1" && model === "browser hitches" && seed === 1,
    ),
  )("%s, %s, seed %i: no rubber-banding, bounded buffer", (name, _model, seed, frames) =>
    browserLikeCase(name, seed, frames),
  );
});
