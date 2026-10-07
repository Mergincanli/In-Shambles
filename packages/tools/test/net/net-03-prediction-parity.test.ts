import { type CmdSampler, MixedInput } from "@game/client/net";
import {
  BUTTON_MASK,
  findNetProfile,
  MOVE_AXIS_MAX,
  type NetProfile,
  type PlayerState,
  PMF_GROUNDED,
  type UserCmd,
  WEAPON_SLOT_COUNT,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { NetHarness } from "./harness";

// NET-03 (docs/05 §14, M2 design §5): prediction parity. The real Match and the real client net
// code over a lossless loopback, a fake clock and frames at 144 Hz ± 1 ms: a 3600-tick mixed
// scripted session, raw input out of every range included, needs 0 corrections, the server never
// starves after the startup fill, and the server's state equals the client's prediction on every
// tick. Variants: wan-50 (delay and jitter, no loss) and a live `set pm_gravity 400` sent by CMD
// halfway, mid-jump (D-027: parameters switch by tick).

const TICKS = 3600;

/** Counts the raw values MixedInput produces outside the ranges sanitizeUserCmd forces. */
class RangeProbe implements CmdSampler {
  outOfRange = 0;
  constructor(private readonly inner: CmdSampler) {}

  sample(cmd: UserCmd, ps: Readonly<PlayerState>): void {
    this.inner.sample(cmd, ps);
    const axis = (v: number) => !(Math.abs(v) <= MOVE_AXIS_MAX) || !Number.isInteger(v);
    if (
      axis(cmd.forward) ||
      axis(cmd.right) ||
      axis(cmd.up) ||
      (cmd.buttons & ~BUTTON_MASK) !== 0 ||
      cmd.yaw > 0xffff ||
      Math.abs(cmd.pitch) > 0xffff / 4 ||
      cmd.weaponSlot >= WEAPON_SLOT_COUNT
    ) {
      this.outOfRange++;
    }
  }
}

function expectParity(h: NetHarness): void {
  const t = h.totals();
  expect(t.corrections, "corrections").toBe(0);
  expect(t.paramResyncs, "parameter resyncs").toBe(0);
  expect(t.hardResyncs, "hard resyncs").toBe(0);
  expect(t.starved, "starved snapshots after startup").toBe(0);
  expect(h.serverStarved.filter((tick) => tick > h.client.startTick)).toEqual([]);
  // Every tick the server simulated, from the spawn on, against the client's prediction.
  expect(h.compared(h.finalPredicted)).toBeGreaterThanOrEqual(TICKS);
  expect(h.mismatches(h.finalPredicted)).toEqual([]);
  expect(h.unreconciled()).toEqual([]);
}

describe("NET-03: prediction parity on a lossless link", () => {
  it("a 3600-tick mixed session with out-of-range raw input: 0 corrections, server == prediction every tick", () => {
    const probe = new RangeProbe(new MixedInput());
    const h = new NetHarness({ input: probe });
    h.runTicks(TICKS);
    expect(probe.outOfRange).toBeGreaterThan(100);
    expectParity(h);
    // No correction ever re-simulated, so the first prediction of each tick was already right.
    expect(h.compared(h.firstPredicted)).toBeGreaterThanOrEqual(TICKS);
    expect(h.mismatches(h.firstPredicted)).toEqual([]);
  });

  it("wan-50 (25 ms each way, ±3 ms jitter): 0 corrections", () => {
    const h = new NetHarness({
      input: new MixedInput(),
      profile: findNetProfile("wan-50") as NetProfile,
      seed: 3,
    });
    h.runTicks(TICKS);
    expect(h.client.clock.rttMs).toBeGreaterThan(50);
    expectParity(h);
    expect(h.mismatches(h.firstPredicted)).toEqual([]);
  });

  it("set pm_gravity 400 by CMD mid-flight: parameters switch at the effective tick, 0 corrections", () => {
    const h = new NetHarness({ input: new MixedInput() });
    h.runTicks(TICKS / 2);
    // Wait for a jump, so the ticks the client already predicted on the old gravity when CVARS
    // arrives are airborne and must be re-simulated (D-027).
    const player = h.match.session(0)?.player;
    for (let i = 0; i < 10_000; i++) {
      if (
        player !== undefined &&
        (player.flags & PMF_GROUNDED) === 0 &&
        (player.velocity[2] as number) > 150
      )
        break;
      h.run(1000 / 144);
    }
    expect((player?.flags ?? PMF_GROUNDED) & PMF_GROUNDED).toBe(0);
    expect(h.client.sendCommand("set pm_gravity 400")).toBe(true);
    h.runTicks(TICKS);
    expect(h.client.prints).toContain("pm_gravity = 400");
    expect(h.match.cvars.getNumber("pm_gravity", 0)).toBe(400);
    expect(h.client.cvars.getNumber("pm_gravity", 0)).toBe(400);
    const effective = h.match.cvarsEffectiveTick;
    expect(effective).toBeGreaterThan(h.client.startTick);
    expect(h.client.predictor.pendingParams).toBe(false);
    // The server was airborne from the effective tick through the ticks the client had already
    // predicted, so their first predictions (old gravity) differ from the server's states, and
    // only those: the immediate re-simulation fixed them before any snapshot was compared.
    const lead = h.client.clock.leadTicks(h.client.settings.inputBuffer);
    for (let tick = effective; tick <= effective + lead; tick++) {
      expect((h.server.get(tick)?.flags ?? PMF_GROUNDED) & PMF_GROUNDED, `tick ${tick}`).toBe(0);
    }
    const stale = h.mismatches(h.firstPredicted, effective);
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.every((tick) => tick <= effective + lead + 1)).toBe(true);
    expect(h.mismatches(h.firstPredicted)).toEqual(stale);
    let airborne = 0;
    for (const [tick, s] of h.server) {
      if (tick >= effective && (s.flags & PMF_GROUNDED) === 0) airborne++;
    }
    expect(airborne).toBeGreaterThan(30);
    expectParity(h);
  });
});
