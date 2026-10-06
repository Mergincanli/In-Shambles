import { describe, expect, it } from "vitest";
import {
  ClientClock,
  HANDSHAKE_PING_SPACING_MS,
  HANDSHAKE_PINGS,
  MAX_FAST_FORWARD_TICKS,
  PING_INTERVAL_MS,
  TICK_MS,
} from "../../src/net/clock";

/** A clock on a settable time slot. */
function rig() {
  const now = new Float64Array(1);
  return { now, clock: new ClientClock(now) };
}

/** Pings and answers `rtts` in turn (one in flight at a time). */
function handshake(r: ReturnType<typeof rig>, rtts: readonly number[]): void {
  for (const rtt of rtts) {
    const id = r.clock.nextPing();
    r.now[0] = (r.now[0] as number) + rtt;
    expect(r.clock.onPong(id)).toBe(true);
    r.now[0] = (r.now[0] as number) + HANDSHAKE_PING_SPACING_MS;
  }
}

describe("ClientClock (M2 design §2, D-028)", () => {
  it("takes the median of five handshake pings, then leads by ceil(RTT / tick) + buffer", () => {
    const r = rig();
    expect(r.clock.pingDue()).toBe(true);
    handshake(r, [90, 30, 200, 40, 50]);
    expect(r.clock.handshakeDone).toBe(true);
    expect(r.clock.sampleCount).toBe(HANDSHAKE_PINGS);
    expect(r.clock.rttMs).toBe(50);
    expect(r.clock.leadTicks(2)).toBe(Math.ceil(50 / TICK_MS) + 2);
    const exact = rig();
    handshake(exact, [TICK_MS, TICK_MS, TICK_MS, TICK_MS, TICK_MS]);
    expect(exact.clock.leadTicks(2)).toBe(3);
    expect(rig().clock.leadTicks(2)).toBe(2);
  });

  it("pings every 50 ms during the handshake, then once a second, and ignores unknown pongs", () => {
    const r = rig();
    const id = r.clock.nextPing();
    expect(r.clock.pingDue()).toBe(false);
    r.now[0] = HANDSHAKE_PING_SPACING_MS;
    expect(r.clock.pingDue()).toBe(true);
    expect(r.clock.onPong(id + 1)).toBe(false);
    expect(r.clock.onPong(id)).toBe(true);
    expect(r.clock.onPong(id)).toBe(false);
    handshake(r, [10, 10, 10, 10]);
    const after = r.now[0] as number;
    r.clock.nextPing();
    r.now[0] = after + PING_INTERVAL_MS - 1;
    expect(r.clock.pingDue()).toBe(false);
    r.now[0] = after + PING_INTERVAL_MS;
    expect(r.clock.pingDue()).toBe(true);
  });

  it.each([700, 1000, 2000])(
    "finishes the handshake at a %i ms round trip with pings every 50 ms",
    (rtt) => {
      // Every ping waits in its own slot until its pong: a slot reused before the pong came back
      // would never be answered and the handshake would never end.
      const r = rig();
      const sent: { id: number; at: number }[] = [];
      for (let t = 0; t < rtt + 1000 && !r.clock.handshakeDone; t++) {
        r.now[0] = t;
        while (sent.length > 0 && t - (sent[0] as { at: number }).at >= rtt) {
          r.clock.onPong((sent.shift() as { id: number }).id);
        }
        if (r.clock.pingDue()) sent.push({ id: r.clock.nextPing(), at: t });
      }
      expect(r.clock.handshakeDone).toBe(true);
      expect(r.clock.rttMs).toBe(rtt);
    },
  );

  it("follows the round trip with an EWMA after the handshake", () => {
    const r = rig();
    handshake(r, [100, 100, 100, 100, 100]);
    for (let i = 0; i < 60; i++) handshake(r, [200]);
    expect(r.clock.rttMs).toBeGreaterThan(199);
    expect(r.clock.jitterMs).toBeGreaterThan(0);
  });

  it("fast-forwards after half a second below target − 1.5, once, then waits for its effect", () => {
    const r = rig();
    r.clock.anchor(10);
    // Snapshots up to the anchor tick are ignored.
    expect(r.clock.onSnapshotHealth(-5, 10, 20, 2)).toBe(0);
    expect(r.clock.healthSamples).toBe(0);
    let step = 0;
    let tick = 11;
    for (; tick < 200 && step === 0; tick++) {
      r.now[0] = tick * TICK_MS;
      step = r.clock.onSnapshotHealth(0, tick, tick + 10, 2);
    }
    expect(step).toBe(2);
    expect((tick - 12) * TICK_MS).toBeGreaterThanOrEqual(500);
    expect(r.clock.adjustments).toBe(1);
    // The step's own snapshots are still in flight: ignored until the step's tick.
    expect(r.clock.ignoreHealthThroughTick).toBe(tick - 1 + 10 + 2);
    expect(r.clock.onSnapshotHealth(0, tick, tick + 12, 2)).toBe(0);
    expect(r.clock.bufferHealth).toBeCloseTo(2, 0);
  });

  it("caps a fast-forward and holds after a second above target + 3", () => {
    const r = rig();
    r.clock.anchor(0);
    let step = 0;
    for (let tick = 1; tick < 200 && step === 0; tick++) {
      r.now[0] = tick * TICK_MS;
      step = r.clock.onSnapshotHealth(-20, tick, tick, 2);
    }
    expect(step).toBe(MAX_FAST_FORWARD_TICKS);
    const h = rig();
    h.clock.anchor(0);
    step = 0;
    let tick = 1;
    for (; tick < 200 && step === 0; tick++) {
      h.now[0] = tick * TICK_MS;
      step = h.clock.onSnapshotHealth(9, tick, tick, 2);
    }
    expect(step).toBe(-7);
    expect((tick - 2) * TICK_MS).toBeGreaterThanOrEqual(1000);
  });

  it("does nothing while the buffer health stays in the band", () => {
    const r = rig();
    r.clock.anchor(0);
    for (let tick = 1; tick < 600; tick++) {
      r.now[0] = tick * TICK_MS;
      expect(r.clock.onSnapshotHealth(tick % 2 === 0 ? 1 : 4, tick, tick, 2)).toBe(0);
    }
    expect(r.clock.adjustments).toBe(0);
  });
});
