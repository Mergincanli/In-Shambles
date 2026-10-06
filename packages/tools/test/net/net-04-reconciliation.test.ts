import { MixedInput, StrafeCircuit } from "@game/client/net";
import { findNetProfile, NET_PROFILES, type NetProfile } from "@game/shared";
import { describe, expect, it } from "vitest";
import { type FrameLog, NetHarness } from "./harness";

// NET-04, the M2 basic version (docs/05 §14, M2 design §5): the automated stand-in for "smooth at
// net_profile wan-150-loss2". The NET-03 harness drives the StrafeCircuit bot (laps of a square on
// movement_lab, strafe-jumping well past the run cap) for 60 s on every docs/10 §3 profile,
// through NetSim with a fixed seed:
// - lan and wan-50: 0 corrections;
// - wan-100-loss1 and wan-150-loss2: under 1 correction per second, mean under 2 u, render offset
//   never 8 u or more, and no frame-to-frame jump in the drawn position (each step at most
//   speed × frame time × 1.5 + 0.5 u);
// - bad-250-loss5: converges (no hard resync, laps go on, the buffer settles) and logs every
//   correction.
// On every profile the prediction converges: at each snapshot the client reconciled with, its
// standing prediction equals the server's recorded state (`NetHarness.unreconciled`), so a
// predictor that stopped correcting fails here, not only in its unit tests.
// One summary line per profile is printed. The full NET-04 (16 bots, every mechanic) comes with M3.

/** The circuit stands still this long first (StrafeCircuit's default), then strafe-jumps 60 s. */
const IDLE_TICKS = 90;
const TICKS = 3600;
const SECONDS = TICKS / 60;
/**
 * NetSim seeds. The lossy WAN profiles run three: corrections are rare there (0 to about 12 a
 * minute, all under a unit), and seeds 5 and 7 have some, so the smoothing path is exercised too.
 */
const SEED = 1;
const LOSSY_SEEDS = [1, 5, 7];

/** The largest frame-to-frame step of the drawn position over its allowance (≤ 1 passes). */
function worstStep(f: FrameLog): number {
  let worst = 0;
  for (let i = 1; i < f.time.length; i++) {
    const step = Math.hypot(
      (f.x[i] as number) - (f.x[i - 1] as number),
      (f.y[i] as number) - (f.y[i - 1] as number),
      (f.z[i] as number) - (f.z[i - 1] as number),
    );
    const speed = Math.max(f.speed[i] as number, f.speed[i - 1] as number);
    const dt = ((f.time[i] as number) - (f.time[i - 1] as number)) / 1000;
    worst = Math.max(worst, step / (speed * dt * 1.5 + 0.5));
  }
  return worst;
}

function run(profile: NetProfile, seed = SEED): NetHarness {
  const h = new NetHarness({
    input: new StrafeCircuit({ idleTicks: IDLE_TICKS }),
    profile,
    seed,
  });
  h.runTicks(IDLE_TICKS + TICKS);
  const t = h.totals();
  const maxOffset = Math.max(...h.frames.offset);
  const maxSpeed = Math.max(...h.frames.speed);
  console.log(
    `NET-04 ${profile.name.padEnd(13)} seed ${seed}: rtt ${h.client.clock.rttMs.toFixed(0).padStart(3)} ms, ` +
      `buffer ${h.client.clock.bufferHealth.toFixed(2)} ticks, ` +
      `${t.corrections} corrections (${(t.corrections / SECONDS).toFixed(2)}/s, ` +
      `mean ${t.meanCorrection.toFixed(2)} u, max ${t.maxCorrection.toFixed(2)} u), ` +
      `render offset max ${maxOffset.toFixed(2)} u, worst step ${worstStep(h.frames).toFixed(2)}, ` +
      `${t.starved} starved, ${t.clockAdjustments} clock steps, top speed ${maxSpeed.toFixed(0)} u/s`,
  );
  return h;
}

/** The circuit ran: the player stayed on the floor and strafe-jumped past the run cap. */
function expectCircuit(h: NetHarness): void {
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const s of h.server.values()) {
    minZ = Math.min(minZ, s.origin[2] as number);
    maxZ = Math.max(maxZ, s.origin[2] as number);
  }
  expect(minZ).toBeGreaterThan(0);
  expect(maxZ).toBeLessThan(100);
  expect(Math.max(...h.frames.speed)).toBeGreaterThan(500);
}

/** Every snapshot the client reconciled with left its prediction equal to the server's state. */
function expectConverged(h: NetHarness): void {
  expect(h.snapshotTicks.length).toBeGreaterThan(TICKS / 2);
  expect(h.unreconciled()).toEqual([]);
}

const profile = (name: string) => findNetProfile(name) as NetProfile;

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
  });

  it.each(
    ["wan-100-loss1", "wan-150-loss2"].flatMap((name) => LOSSY_SEEDS.map((seed) => [name, seed])),
  )("%s, seed %i: corrections rare and small, no visible rubber-banding", (name, seed) => {
    const h = run(profile(name as string), seed as number);
    expectCircuit(h);
    expectConverged(h);
    const t = h.totals();
    expect(t.corrections / SECONDS).toBeLessThan(1);
    expect(t.meanCorrection).toBeLessThan(2);
    expect(t.hardResyncs).toBe(0);
    expect(Math.max(...h.frames.offset)).toBeLessThan(8);
    expect(worstStep(h.frames)).toBeLessThanOrEqual(1);
    // Every correction is logged, with the fields that differed.
    expect(h.client.predictor.corrections.total).toBe(t.corrections);
  });

  it("bad-250-loss5: converges and logs its corrections", () => {
    const h = run(profile("bad-250-loss5"));
    expectCircuit(h);
    expectConverged(h);
    const t = h.totals();
    // The link is bad enough that the correction path runs.
    expect(t.corrections).toBeGreaterThan(0);
    const c = h.client;
    expect(t.hardResyncs).toBe(0);
    expect(c.clock.bufferHealth).toBeGreaterThan(c.settings.inputBuffer - 1.5);
    expect(c.clock.bufferHealth).toBeLessThan(c.settings.inputBuffer + 3);
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

  it("re-anchors the clock in steps after a round-trip step up and down (smooth dilation is NET-07)", () => {
    const h = new NetHarness({ input: new StrafeCircuit(), profile: profile("wan-50"), seed: 3 });
    h.runTicks(600);
    const c = h.client;
    const clock = c.clock;
    const target = c.settings.inputBuffer;
    // The lead over the server's tick is the uplink delay plus the buffer, measured from the
    // server's side rather than from the clock's own EWMA.
    const lead0 = h.lead();
    expect(lead0).toBeGreaterThanOrEqual(target + 1);
    // 100 ms more round trip: the buffer runs dry, the server starves, the clock fast-forwards.
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
    // Back to lan: inputs arrive 75 ms early, the clock holds and the lead shrinks to the buffer.
    h.sim?.setProfile(profile("lan"));
    h.run(4000);
    expect(clock.holds).toBeGreaterThanOrEqual(1);
    expect(h.totals().clockAdjustments).toBe(clock.fastForwards + clock.holds);
    expect(clock.bufferHealth).toBeLessThan(target + 3);
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
