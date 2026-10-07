import { describe, expect, it } from "vitest";
import {
  ClientClock,
  HANDSHAKE_PING_SPACING_MS,
  HANDSHAKE_PINGS,
  LOW_WINDOW,
  MAX_ADAPTIVE_TICKS,
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

  it("fast-forwards within 100 ms of a steady deficit, to the target, then waits for its effect", () => {
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
    // A dip lasting six snapshots is a pattern, not a lone lost INPUT (the old clock waited 0.5 s).
    expect(step).toBe(2);
    expect(tick - 11).toBe(6);
    expect(r.clock.adjustments).toBe(1);
    expect(r.clock.fastForwards).toBe(1);
    // The step's own snapshots are still in flight: ignored until the step's tick.
    expect(r.clock.ignoreHealthThroughTick).toBe(tick - 1 + 10 + 2);
    expect(r.clock.onSnapshotHealth(0, tick, tick + 12, 2)).toBe(0);
    expect(r.clock.healthSamples).toBe(6);
    // The mean and the low edge moved by the step at once.
    expect(r.clock.bufferHealth).toBeCloseTo(2, 9);
    expect(r.clock.bufferLow).toBe(2);
  });

  it("a saw-tooth of bursts grows the lead after its third dip, by the dip's full depth", () => {
    // Frames 5 ticks long: the health falls a tick per snapshot, then a burst of cmds restores
    // it. Its mean (1) sits inside the old clock's band, but every burst's low point starves.
    const saw = [3, 2, 1, 0, -1];
    const r = rig();
    r.clock.anchor(0);
    const steps: [number, number][] = [];
    let base = 0;
    let tick = 1;
    for (let i = 0; i < 600; i++, tick++) {
      r.now[0] = tick * TICK_MS;
      const step = r.clock.onSnapshotHealth((saw[i % 5] as number) + base, tick, tick, 2);
      if (step !== 0) {
        steps.push([i, step]);
        // The cmds now arrive `step` ticks earlier; the snapshots in flight are skipped.
        base += step;
        expect(r.clock.ignoreHealthThroughTick).toBe(tick + step);
      }
    }
    // One step, on the snapshot right after the third dip's bottom: −1 lifted to the target.
    expect(steps).toEqual([[15, 3]]);
    expect(r.clock.bufferLow).toBe(2);
    // The mean now sits the spread above the low edge, which a full window turns into the lead
    // an anchor adds.
    expect(r.clock.bufferHealth).toBeCloseTo(4, 0);
    expect(r.clock.adaptiveTicks).toBe(2);
    expect(r.clock.leadTicks(2)).toBe(4);
  });

  it("leaves lone dips alone: a step needs three in the window", () => {
    const r = rig();
    r.clock.anchor(0);
    let tick = 1;
    const feed = (h: number) => {
      r.now[0] = tick * TICK_MS;
      return r.clock.onSnapshotHealth(h, tick, tick++, 2);
    };
    for (let i = 0; i < 100; i++) expect(feed(2)).toBe(0);
    for (let dip = 0; dip < 2; dip++) {
      expect(feed(0)).toBe(0);
      for (let i = 0; i < 20; i++) expect(feed(2)).toBe(0);
    }
    expect(r.clock.bufferLow).toBe(0);
    expect(feed(-1)).toBe(0);
    // The third dip's bottom has passed: lifted to the target.
    expect(feed(2)).toBe(3);
    // Two dips that leave the window are forgotten: the count is over the window only.
    const q = rig();
    q.clock.anchor(0);
    tick = 1;
    const feedQ = (h: number) => {
      q.now[0] = tick * TICK_MS;
      return q.clock.onSnapshotHealth(h, tick, tick++, 2);
    };
    for (let dip = 0; dip < 6; dip++) {
      expect(feedQ(0)).toBe(0);
      for (let i = 0; i < LOW_WINDOW / 2; i++) expect(feedQ(2)).toBe(0);
    }
    expect(q.clock.adjustments).toBe(0);
  });

  it("releases the low edge after the window and holds the extra lead back once the spread is gone", () => {
    const saw = [7, 6, 5, 4, 3, 2];
    const r = rig();
    r.clock.anchor(0);
    let tick = 1;
    for (let i = 0; i < 300; i++, tick++) {
      r.now[0] = tick * TICK_MS;
      expect(r.clock.onSnapshotHealth(saw[i % 6] as number, tick, tick, 2)).toBe(0);
    }
    expect(r.clock.bufferLow).toBe(2);
    expect(r.clock.bufferHealth).toBeCloseTo(4.5, 0);
    // Frames get short: the health stays at the top of the old saw-tooth.
    const calm = tick;
    let step = 0;
    for (; tick < calm + 600 && step === 0; tick++) {
      r.now[0] = tick * TICK_MS;
      step = r.clock.onSnapshotHealth(7, tick, tick, 2);
      // The window still holds the old dips: the low edge stays down that long.
      if (tick - calm < LOW_WINDOW - 6) expect(r.clock.bufferLow).toBe(2);
    }
    // Low edge and mean 5 above the target: held back after a second more, to the target.
    expect(step).toBe(-5);
    expect((tick - calm) * TICK_MS).toBeGreaterThanOrEqual(1000 + (LOW_WINDOW - 6) * TICK_MS);
    expect(r.clock.holds).toBe(1);
    expect(r.clock.bufferLow).toBe(2);
    expect(r.clock.ignoreHealthThroughTick).toBe(tick - 1 + 5);
    // From then on the steady health sits on the target: nothing more to do.
    for (let i = 0; i < 600; i++, tick++) {
      r.now[0] = tick * TICK_MS;
      expect(r.clock.onSnapshotHealth(2, tick, tick, 2)).toBe(0);
    }
    expect(r.clock.adaptiveTicks).toBe(0);
  });

  it("waits four seconds before holding back a small excess", () => {
    const r = rig();
    r.clock.anchor(0);
    let step = 0;
    let tick = 1;
    for (; tick < 1000 && step === 0; tick++) {
      r.now[0] = tick * TICK_MS;
      step = r.clock.onSnapshotHealth(5, tick, tick, 2);
    }
    expect(step).toBe(-3);
    expect((tick - 2) * TICK_MS).toBeGreaterThanOrEqual(4000);
    expect((tick - 2) * TICK_MS).toBeLessThan(4100);
  });

  it("caps the adaptive part: past about target + 8 the clock starves rather than grows", () => {
    // Bursts of 30 ticks: no allowed buffer covers them.
    const r = rig();
    r.clock.anchor(0);
    let base = 0;
    let tick = 1;
    let last = 0;
    let sum = 0;
    for (let i = 0; i < 1800; i++, tick++) {
      r.now[0] = tick * TICK_MS;
      const step = r.clock.onSnapshotHealth(16 - (i % 30) + base, tick, tick, 2);
      if (step !== 0) last = i;
      base += step;
      if (i >= 1200) sum += r.clock.bufferHealth;
    }
    // A few fast-forwards early on, then none: the cap is checked against the window's average,
    // which the snapshots skipped after each step bias by about a tick. The mean settles within
    // two ticks of the cap, the low edge stays below the margin, and the clock never holds back
    // what it grew (no oscillation).
    expect(r.clock.fastForwards).toBeGreaterThanOrEqual(2);
    expect(r.clock.holds).toBe(0);
    expect(last).toBeLessThan(300);
    expect(sum / 600).toBeLessThanOrEqual(2 + MAX_ADAPTIVE_TICKS + 2);
    expect(r.clock.bufferLow).toBeLessThan(1);
    expect(r.clock.adaptiveTicks).toBe(MAX_ADAPTIVE_TICKS);
    expect(r.clock.leadTicks(2)).toBe(2 + MAX_ADAPTIVE_TICKS);
  });

  it("a second shallow hard resync within the window grows the adaptive lead, which anchors keep and reset clears", () => {
    const r = rig();
    r.now[0] = 1000;
    r.clock.onResync(0, 2);
    r.clock.onResync(MAX_ADAPTIVE_TICKS + 1, 2);
    expect(r.clock.adaptiveTicks).toBe(0);
    // A lone resync (one long frame) is left alone, like a lone dip ...
    r.clock.onResync(2, 2);
    expect(r.clock.adaptiveTicks).toBe(0);
    // ... and so is the next one once the window has passed.
    r.now[0] += LOW_WINDOW * TICK_MS + 1;
    r.clock.onResync(2, 2);
    expect(r.clock.adaptiveTicks).toBe(0);
    // A second within the window is a rhythm: the server got 2 ticks past the prediction, a dip
    // to −2, lifted to the target.
    r.now[0] += 300;
    r.clock.onResync(2, 2);
    expect(r.clock.adaptiveTicks).toBe(4);
    expect(r.clock.leadTicks(2)).toBe(6);
    r.clock.anchor(100);
    expect(r.clock.adaptiveTicks).toBe(4);
    r.now[0] += 300;
    r.clock.onResync(5, 2);
    expect(r.clock.adaptiveTicks).toBe(MAX_ADAPTIVE_TICKS);
    r.clock.reset();
    expect(r.clock.adaptiveTicks).toBe(0);
  });

  it("holds back an excess the health reaches from below (the EWMA stalls a few ulps short)", () => {
    const r = rig();
    r.clock.anchor(0);
    let tick = 1;
    for (; tick <= 200; tick++) {
      r.now[0] = tick * TICK_MS;
      expect(r.clock.onSnapshotHealth(3, tick, tick, 2)).toBe(0);
    }
    const from = tick;
    let step = 0;
    for (; tick < from + 600 && step === 0; tick++) {
      r.now[0] = tick * TICK_MS;
      step = r.clock.onSnapshotHealth(4, tick, tick, 2);
    }
    expect(step).toBe(-2);
    // The low edge waits out the window (target + 1 still in it), then four seconds.
    expect((tick - from) * TICK_MS).toBeGreaterThanOrEqual(4000 + (LOW_WINDOW - 1) * TICK_MS);
    expect((tick - from) * TICK_MS).toBeLessThan(4100 + LOW_WINDOW * TICK_MS);
  });

  it("asks for no step on health at the i8 floor (an uplink outage: depth unknown)", () => {
    const r = rig();
    r.clock.anchor(0);
    let tick = 1;
    const feed = (h: number) => {
      r.now[0] = tick * TICK_MS;
      return r.clock.onSnapshotHealth(h, tick, tick++, 2);
    };
    for (let i = 0; i < 100; i++) expect(feed(2)).toBe(0);
    // The cmds stop arriving: the health falls a tick per snapshot to the clamp and stays there.
    for (let h = 1; h > -128; h--) expect(feed(h)).toBe(0);
    for (let i = 0; i < 300; i++) expect(feed(-128)).toBe(0);
    expect(r.clock.adjustments).toBe(0);
    // The link comes back: one dip, not a rhythm, so still nothing to do.
    for (let i = 0; i < 30; i++) expect(feed(2)).toBe(0);
    expect(r.clock.adjustments).toBe(0);
  });

  it("keeps showing the last low edge across an anchor until the window refills", () => {
    const r = rig();
    r.clock.anchor(0);
    for (let tick = 1; tick <= 100; tick++) {
      r.now[0] = tick * TICK_MS;
      r.clock.onSnapshotHealth(3, tick, tick, 2);
    }
    r.clock.anchor(120);
    expect(r.clock.bufferLow).toBe(3);
    r.clock.onSnapshotHealth(2, 121, 121, 2);
    expect(r.clock.bufferLow).toBe(2);
  });

  it("caps a fast-forward and holds after a second 4 or more above the target", () => {
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
