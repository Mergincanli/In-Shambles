import { describe, expect, it } from "vitest";
import {
  ClientClock,
  DIL_MAX,
  HANDSHAKE_PING_SPACING_MS,
  HANDSHAKE_PINGS,
  LOW_FAST_WINDOW,
  LOW_WINDOW,
  MAX_ADAPTIVE_TICKS,
  MAX_FAST_FORWARD_TICKS,
  PING_INTERVAL_MS,
  TICK_MS,
} from "../../src/net/clock";

/** A clock on a settable time slot. */
function rig(dilation = true) {
  const now = new Float64Array(1);
  return { now, clock: new ClientClock(now, { dilation }) };
}

/** Feeds healths one snapshot a tick from tick 1 (after an anchor at 0); returns each step. */
function feeder(r: ReturnType<typeof rig>) {
  r.clock.anchor(0);
  let tick = 1;
  return (h: number) => {
    r.now[0] = tick * TICK_MS;
    const step = r.clock.onSnapshotHealth(h, tick, tick, 2);
    tick++;
    return step;
  };
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

describe("ClientClock (M2 design §2, M3 design §2.7, D-028, D-039)", () => {
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

  it("fast-forwards within 100 ms of a steady deficit, to target − 1, then waits for its effect", () => {
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
    // A dip lasting six snapshots is a pattern, not a lone lost INPUT. It lifts the low edge to
    // target − 1; dilation closes the last tick.
    expect(step).toBe(1);
    expect(tick - 11).toBe(6);
    expect(r.clock.adjustments).toBe(1);
    expect(r.clock.fastForwards).toBe(1);
    // The step's own snapshots are still in flight: ignored until the step's tick.
    expect(r.clock.ignoreHealthThroughTick).toBe(tick - 1 + 10 + 1);
    expect(r.clock.onSnapshotHealth(0, tick, tick + 11, 2)).toBe(0);
    expect(r.clock.healthSamples).toBe(6);
    // The mean and the low edges moved by the step at once; one tick short: +2%.
    expect(r.clock.bufferHealth).toBeCloseTo(1, 9);
    expect(r.clock.bufferLow).toBe(1);
    expect(r.clock.bufferLowFast).toBe(1);
    expect(r.clock.dilation).toBeCloseTo(0.02, 12);
  });

  it("a saw-tooth of bursts fast-forwards after its third dip, to a tick short of the target", () => {
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
    // One step, on the snapshot right after the third dip's bottom: −1 lifted to target − 1.
    // (This plant has no rate: dilation's last tick never shows, so +2% stays on.)
    expect(steps).toEqual([[15, 2]]);
    expect(r.clock.bufferLow).toBe(1);
    expect(r.clock.dilation).toBeCloseTo(0.02, 12);
    // The window's spread over the target (average 3, low edge 1): one tick of adaptive lead.
    expect(r.clock.adaptiveTicks).toBe(1);
    expect(r.clock.leadTicks(2)).toBe(3);
  });

  it("leaves lone dips to dilation: a step needs three in the window", () => {
    const r = rig();
    const feed = feeder(r);
    for (let i = 0; i < 100; i++) expect(feed(2)).toBe(0);
    for (let dip = 0; dip < 2; dip++) {
      expect(feed(0)).toBe(0);
      for (let i = 0; i < 20; i++) expect(feed(2)).toBe(0);
    }
    expect(r.clock.bufferLow).toBe(0);
    expect(feed(-1)).toBe(0);
    // The third dip's bottom has passed: lifted to target − 1.
    expect(feed(2)).toBe(2);
    // Two dips that leave the window are forgotten: the count is over the window only.
    const q = rig();
    const feedQ = feeder(q);
    for (let dip = 0; dip < 6; dip++) {
      expect(feedQ(0)).toBe(0);
      for (let i = 0; i < LOW_WINDOW / 2; i++) expect(feedQ(2)).toBe(0);
    }
    expect(q.clock.adjustments).toBe(0);
  });

  it("speeds up at once on a dip, by 0.02 a tick up to the cap, for as long as the fast window holds it", () => {
    // The design's values (docs/05 §8.2's ±3%, M3 design §2.7's 0.5 s fast window), written out
    // so a changed constant fails here rather than the tests following it.
    expect(DIL_MAX).toBe(0.03);
    expect(LOW_FAST_WINDOW).toBe(30);
    const r = rig();
    const feed = feeder(r);
    for (let i = 0; i < 100; i++) feed(2);
    expect(r.clock.dilation).toBe(0);
    // A tick below the target: +2% on that snapshot (the deadband is half a tick) ...
    feed(1);
    expect(r.clock.dilation).toBeCloseTo(0.02, 12);
    // ... two ticks below: the cap.
    feed(0);
    expect(r.clock.dilation).toBe(DIL_MAX);
    // The dip stays in the fast window for LOW_FAST_WINDOW snapshots, then δ is back to 0.
    for (let i = 0; i < LOW_FAST_WINDOW - 1; i++) {
      feed(2);
      expect(r.clock.dilation).toBeGreaterThan(0);
    }
    feed(2);
    expect(r.clock.dilation).toBe(0);
    expect(r.clock.bufferLowFast).toBe(2);
    // The full window still holds the dip: no slow-down either.
    expect(r.clock.bufferLow).toBe(0);
    expect(r.clock.adjustments).toBe(0);
  });

  it("slows down only on a full window whose low edge and mean are a tick or more above the target", () => {
    const r = rig();
    const feed = feeder(r);
    // A partial window (after an anchor) never slows down, however high.
    for (let i = 0; i < LOW_WINDOW - 1; i++) {
      feed(5);
      expect(r.clock.dilation).toBe(0);
    }
    feed(5);
    // Three above: the cap, −3%.
    expect(r.clock.dilation).toBe(-DIL_MAX);
    // A sample at target + 1 brings the low edge down: −2%; one on the target stops it.
    feed(3);
    expect(r.clock.dilation).toBeCloseTo(-0.02, 12);
    feed(2);
    expect(r.clock.dilation).toBe(0);
    // That sample blocks slowing down for the whole window (D-028's lesson), even with the
    // health back up all the while.
    for (let i = 0; i < LOW_WINDOW - 1; i++) {
      feed(5);
      expect(r.clock.dilation).toBe(0);
    }
    feed(5);
    expect(r.clock.dilation).toBe(-DIL_MAX);
    expect(r.clock.holds).toBe(0);
  });

  it("slows down for a health settled at exactly target + 1 from below (the EWMA stalls a few ulps short)", () => {
    const r = rig();
    const feed = feeder(r);
    for (let i = 0; i < 200; i++) feed(2);
    for (let i = 0; i < LOW_WINDOW - 1; i++) {
      feed(3);
      expect(r.clock.dilation).toBe(0);
    }
    for (let i = 0; i < 600; i++) feed(3);
    expect(r.clock.bufferHealth).toBeLessThanOrEqual(3);
    expect(r.clock.dilation).toBeLessThan(-0.0199);
    expect(r.clock.adjustments).toBe(0);
  });

  it("holds only once the whole window is target + 6 or more above, back to target + 2", () => {
    const r = rig();
    const feed = feeder(r);
    // Five above: dilation's, never a hold.
    for (let i = 0; i < 600; i++) expect(feed(7)).toBe(0);
    expect(r.clock.dilation).toBe(-DIL_MAX);
    // Exactly six above: held once the window is full of it, by 6 − 2.
    const e = rig();
    const feedE = feeder(e);
    let stepE = 0;
    let nE = 0;
    for (; nE < 200 && stepE === 0; nE++) stepE = feedE(8);
    expect(stepE).toBe(-4);
    expect(nE).toBe(LOW_WINDOW);
    // Seven above: by 7 − 2.
    const h = rig();
    const feedH = feeder(h);
    let step = 0;
    let n = 0;
    for (; n < 200 && step === 0; n++) step = feedH(9);
    expect(step).toBe(-5);
    expect(n).toBe(LOW_WINDOW);
    expect(h.clock.holds).toBe(1);
    expect(h.clock.bufferLow).toBe(4);
    // The last two ticks are dilation's.
    expect(h.clock.dilation).toBe(-DIL_MAX);
    // A hold never comes for a window with any sample under target + 6.
    const q = rig();
    const feedQ = feeder(q);
    for (let i = 0; i < 600; i++) expect(feedQ(i % 60 === 0 ? 7 : 12)).toBe(0);
  });

  it("caps the adaptive part: past about target + 8 the clock starves rather than grows, and slows down past target + 10", () => {
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
    // A window whose average is more than target + 10 slows at the cap, even with its fast low
    // edge below the target (the excess wins over the speed-up).
    const x = rig();
    const feedX = feeder(x);
    for (let i = 0; i < LOW_WINDOW; i++) feedX(i % 30 === 29 ? 0 : 14);
    expect(x.clock.bufferLowFast).toBe(0);
    expect(x.clock.dilation).toBe(-DIL_MAX);
    expect(x.clock.adjustments).toBe(0);
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

  it("asks for no step on health at the i8 floor (an uplink outage: depth unknown)", () => {
    const r = rig();
    const feed = feeder(r);
    for (let i = 0; i < 100; i++) expect(feed(2)).toBe(0);
    // The cmds stop arriving: the health falls a tick per snapshot to the clamp and stays there.
    for (let h = 1; h > -128; h--) expect(feed(h)).toBe(0);
    for (let i = 0; i < 300; i++) expect(feed(-128)).toBe(0);
    expect(r.clock.adjustments).toBe(0);
    // Dilation is bounded meanwhile: +3%.
    expect(r.clock.dilation).toBe(DIL_MAX);
    // The link comes back: one dip, not a rhythm, so still no step.
    for (let i = 0; i < 30; i++) expect(feed(2)).toBe(0);
    expect(r.clock.adjustments).toBe(0);
  });

  it("keeps showing the last low edge across an anchor until the window refills, and drops δ", () => {
    const r = rig();
    const feed = feeder(r);
    for (let i = 0; i < 100; i++) feed(1);
    expect(r.clock.dilation).toBeGreaterThan(0);
    r.clock.anchor(120);
    expect(r.clock.bufferLow).toBe(1);
    expect(r.clock.dilation).toBe(0);
    r.clock.onSnapshotHealth(2, 121, 121, 2);
    expect(r.clock.bufferLow).toBe(2);
  });

  it("caps a fast-forward at MAX_FAST_FORWARD_TICKS", () => {
    const r = rig();
    const feed = feeder(r);
    let step = 0;
    for (let i = 0; i < 200 && step === 0; i++) step = feed(-20);
    expect(step).toBe(MAX_FAST_FORWARD_TICKS);
  });

  it("does no step while the health stays in the band, and speeds up for its dips", () => {
    const r = rig();
    const feed = feeder(r);
    for (let i = 0; i < 600; i++) expect(feed(i % 2 === 0 ? 1 : 4)).toBe(0);
    expect(r.clock.adjustments).toBe(0);
    expect(r.clock.dilation).toBeCloseTo(0.02, 12);
  });

  it("keeps δ at 0 with `dilation: false` (NET-07's control), steps unchanged", () => {
    const r = rig(false);
    const feed = feeder(r);
    let steps = 0;
    for (let i = 0; i < 300; i++) {
      // A 3-tick deficit (one fast-forward to target − 1 answers it), then 4 ticks too many.
      if (feed(i < 6 ? 0 : i < 150 ? 1 : 6) !== 0) steps++;
      expect(r.clock.dilation).toBe(0);
    }
    expect(steps).toBe(1);
    expect(r.clock.fastForwards).toBe(1);
  });
});

/**
 * A plant for the clock (M3 design §2.7 "Stability"): the real clock with its EWMA and windows,
 * against a lead that integrates δ, a server that reports floor(lead − uplink) a round trip later,
 * uniform jitter on the uplink, and ±0.4 ticks of frame noise. Integer ticks, 60 a second.
 */
class Plant {
  readonly now = new Float64Array(1);
  readonly clock: ClientClock;
  /** The client's lead over the server per tick (ticks; continuous), and the health reports. */
  readonly lead: number[] = [];
  private readonly arrivals: { at: number; tick: number; health: number }[] = [];
  readonly dilation: number[] = [];
  readonly lowFast: number[] = [];
  readonly mean: number[] = [];
  tick = 0;
  /** Uplink and downlink delay, ticks. */
  up = 2;
  down = 2;
  private seed = 1;

  constructor(dilation = true) {
    this.clock = new ClientClock(this.now, { dilation });
    this.clock.anchor(0);
    // Steady on the target: the health floor(lead − up) is 2.
    this.lead.push(this.up + 2.5);
  }

  private noise(): number {
    // A small LCG: deterministic, no Math.random.
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  run(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.step();
  }

  private step(): void {
    const n = ++this.tick;
    let lead = (this.lead[n - 1] as number) + (this.clock.dilation as number);
    // The health the server reports at n: the newest cmd sent `up` ticks ago (jittered by up to
    // a tick, never reordered), so floor(lead then − up).
    const sent = Math.max(0, n - this.up - (this.noise() < 0.2 ? 1 : 0));
    const at = this.lead[sent] ?? lead;
    const health = Math.floor(at - (n - sent) + (this.noise() - 0.5) * 0.8);
    this.arrivals.push({ at: n + this.down, tick: n, health });
    this.now[0] = n * TICK_MS;
    while (this.arrivals.length > 0 && (this.arrivals[0] as { at: number }).at <= n) {
      const a = this.arrivals.shift() as { tick: number; health: number };
      const step = this.clock.onSnapshotHealth(a.health, a.tick, n + Math.floor(lead), 2);
      lead += step;
    }
    this.lead.push(lead);
    this.dilation.push(this.clock.dilation);
    this.lowFast.push(this.clock.bufferLowFast);
    this.mean.push(this.clock.bufferHealth);
  }

  /**
   * Ticks from `from` until the fast low edge stays at target − 1 or above and the mean within
   * [target − 0.5, target + 2] (the noise's spread, about a tick and a half) for good; Infinity
   * when the last tick is still out.
   */
  settledAfter(from: number): number {
    let last = -1;
    const n = this.mean.length;
    for (let i = from; i < n; i++) {
      const m = this.mean[i] as number;
      if ((this.lowFast[i] as number) < 1 || m < 1.5 || m > 4) last = i;
    }
    if (last === n - 1) return Number.POSITIVE_INFINITY;
    return last < 0 ? 0 : last + 1 - from;
  }

  signChanges(from: number): number {
    let n = 0;
    let sign = 0;
    for (let i = from; i < this.dilation.length; i++) {
      const s = Math.sign(this.dilation[i] as number);
      if (s === 0) continue;
      if (sign !== 0 && s !== sign) n++;
      sign = s;
    }
    return n;
  }
}

describe("ClientClock against a lagged plant (M3 design §2.7 stability)", () => {
  it.each([
    [2, 5, 120, 2],
    [5, 2, 240, 0],
    [2, 8, 120, 2],
  ])(
    "uplink %i → %i ticks: settles within %i ticks with at most %i fast-forwards, no oscillation",
    (from, to, bound, maxFf) => {
      const p = new Plant();
      p.up = from;
      p.down = from;
      p.lead[0] = from + 2.5;
      p.run(600);
      const ff = p.clock.fastForwards;
      const at = p.tick;
      p.up = to;
      p.down = to;
      p.run(600);
      const settle = p.settledAfter(at);
      expect(settle).toBeLessThanOrEqual(bound);
      expect(p.clock.fastForwards - ff).toBeLessThanOrEqual(maxFf);
      expect(p.clock.holds).toBe(0);
      // Steady again: δ changes sign at most twice, |δ| ≤ 3% throughout.
      expect(p.signChanges(at + settle)).toBeLessThanOrEqual(2);
      for (const d of p.dilation) expect(Math.abs(d)).toBeLessThanOrEqual(DIL_MAX);
      // The lead ends a buffer's worth past the uplink, give or take the noise.
      const lead = p.lead[p.lead.length - 1] as number;
      expect(lead - to).toBeGreaterThan(1.5);
      expect(lead - to).toBeLessThan(4.5);
    },
  );

  it("without dilation the plant never gives back a smaller step down", () => {
    const p = new Plant(false);
    p.up = 5;
    p.down = 5;
    p.lead[0] = 7.5;
    p.run(600);
    const at = p.tick;
    p.up = 2;
    p.down = 2;
    p.run(600);
    // The 3 ticks of extra lead stay: under the hold threshold, and nothing else gives them back.
    expect(p.settledAfter(at)).toBe(Number.POSITIVE_INFINITY);
    expect(p.clock.holds).toBe(0);
  });
});
