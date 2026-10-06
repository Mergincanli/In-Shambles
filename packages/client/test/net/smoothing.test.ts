import { vec3 } from "@game/shared";
import { describe, expect, it } from "vitest";
import { RenderOffset, STEP_SMOOTH_MAX, StepSmoother, ViewHeight } from "../../src/net/smoothing";
import {
  NetStats,
  STAT_BYTES_IN,
  STAT_CORRECTION_MAX,
  STAT_CORRECTIONS,
} from "../../src/net/stats";

describe("RenderOffset (docs/05 §5 step 4)", () => {
  it("decays linearly to zero over its duration", () => {
    const now = new Float64Array([1000]);
    const o = new RenderOffset(now);
    const out = vec3();
    o.add(vec3(10, -4, 2), 100);
    o.sample(out);
    expect(Array.from(out)).toEqual([10, -4, 2]);
    now[0] = 1025;
    o.sample(out);
    expect(Array.from(out)).toEqual([7.5, -3, 1.5]);
    now[0] = 1100;
    o.sample(out);
    expect(Array.from(out).map(Math.abs)).toEqual([0, 0, 0]);
    now[0] = 5000;
    o.sample(out);
    expect(Array.from(out).map(Math.abs)).toEqual([0, 0, 0]);
  });

  it("adds a new offset to what remains and restarts the decay; clear and 0 ms drop it", () => {
    const now = new Float64Array([0]);
    const o = new RenderOffset(now);
    const out = vec3();
    o.add(vec3(8, 0, 0), 100);
    now[0] = 50;
    o.add(vec3(1, 0, 0), 100);
    o.sample(out);
    expect(out[0]).toBe(5);
    now[0] = 100;
    o.sample(out);
    expect(out[0]).toBe(2.5);
    o.clear();
    o.sample(out);
    expect(out[0]).toBe(0);
    o.add(vec3(3, 3, 3), 0);
    o.sample(out);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });
});

describe("NetStats", () => {
  it("sums the last second in 100 ms buckets, keeps totals, and takes maxima", () => {
    const now = new Float64Array([0]);
    const s = new NetStats(now);
    const w = new Float64Array(16);
    for (let ms = 0; ms < 2000; ms += 10) {
      now[0] = ms;
      s.advance();
      s.add(STAT_BYTES_IN, 10);
    }
    s.lastSecond(w);
    expect(w[STAT_BYTES_IN]).toBe(1000);
    expect(s.totals[STAT_BYTES_IN]).toBe(2000);
    s.add(STAT_CORRECTIONS, 1);
    s.add(STAT_CORRECTION_MAX, 3);
    s.add(STAT_CORRECTION_MAX, 1.5);
    s.lastSecond(w);
    expect([w[STAT_CORRECTIONS], w[STAT_CORRECTION_MAX]]).toEqual([1, 3]);
    // A quiet second empties the window but not the totals.
    now[0] = 3500;
    s.advance();
    s.lastSecond(w);
    expect([w[STAT_BYTES_IN], w[STAT_CORRECTION_MAX]]).toEqual([0, 0]);
    expect(s.totals[STAT_CORRECTION_MAX]).toBe(3);
    s.reset();
    expect(s.totals[STAT_BYTES_IN]).toBe(0);
  });
});

describe("StepSmoother (M2 design §2)", () => {
  /** The drawn eye z at render tick r for a path that steps up `dz` at `tick`, plus the offset. */
  function drawn(r: number, tick: number, dz: number, offset: number) {
    const a = Math.min(1, Math.max(0, r - (tick - 1)));
    return dz * a + offset;
  }

  it("holds the eye through the step's tick, then decays over cl_stepSmoothMs", () => {
    const time = new Float64Array([99]);
    const s = new StepSmoother(time);
    const out = new Float64Array(1);
    s.add(100, 18, 150);
    const seen: number[] = [];
    for (let r = 99; r <= 112; r += 0.125) {
      time[0] = r;
      s.sample(out, 0);
      const z = drawn(r, 100, 18, out[0] as number);
      seen.push(z);
      if (r <= 100) expect(z).toBeCloseTo(0, 12);
    }
    // 150 ms = 9 ticks: half gone at 104.5, gone at 109.
    const again = new StepSmoother(time);
    again.add(100, 18, 150);
    time[0] = 104.5;
    again.sample(out, 0);
    expect(out[0]).toBeCloseTo(-9, 9);
    time[0] = 109;
    again.sample(out, 0);
    expect(Math.abs(out[0] as number)).toBe(0);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i] as number).toBeGreaterThanOrEqual((seen[i - 1] as number) - 1e-12);
      // Continuous: no frame-to-frame jump bigger than the decay's slope allows.
      expect((seen[i] as number) - (seen[i - 1] as number)).toBeLessThan(0.26);
    }
    expect(seen.at(-1)).toBe(18);
  });

  it("shifts with a jump of the render-tick clock, so the offset carries on unchanged", () => {
    const time = new Float64Array([104.5]);
    const s = new StepSmoother(time);
    const out = new Float64Array(1);
    s.add(100, 18, 150);
    s.sample(out, 0);
    expect(out[0]).toBeCloseTo(-9, 9);
    // The clock jumps back 3 ticks (a hold) and forward 5 (a fast-forward): same offset.
    for (const jump of [-3, 5]) {
      time[0] = (time[0] as number) + jump;
      s.shift(jump);
      s.sample(out, 0);
      expect(out[0]).toBeCloseTo(-9, 9);
    }
    s.shift(0);
    time[0] = (time[0] as number) + 4.5;
    s.sample(out, 0);
    expect(Math.abs(out[0] as number)).toBe(0);
  });

  it("adds up stairs and caps the sum at 32 u", () => {
    const time = new Float64Array([0]);
    const s = new StepSmoother(time);
    const out = new Float64Array(1);
    for (let t = 1; t <= 6; t++) s.add(t, 16, 1000);
    time[0] = 3;
    s.sample(out, 0);
    expect(out[0]).toBe(-STEP_SMOOTH_MAX);
    s.clear();
    s.sample(out, 0);
    expect(Math.abs(out[0] as number)).toBe(0);
    // Step-downs smooth the other way; 0 ms snaps once the tick is drawn.
    s.add(10, -16, 0);
    time[0] = 9.5;
    s.sample(out, 0);
    expect(out[0]).toBe(8);
    time[0] = 10;
    s.sample(out, 0);
    expect(Math.abs(out[0] as number)).toBe(0);
  });
});

describe("ViewHeight (docs/06 §7)", () => {
  it("moves linearly to the stance height over cl_viewHeightSmoothMs", () => {
    const now = new Float64Array([0]);
    const v = new ViewHeight(now);
    v.update(26, 14, 100);
    expect(v.height[0]).toBe(26);
    now[0] = 50;
    v.update(26, 14, 100);
    expect(v.height[0]).toBe(26);
    now[0] = 75;
    v.update(12, 14, 100);
    expect(v.height[0]).toBe(22.5);
    now[0] = 500;
    v.update(12, 14, 100);
    expect(v.height[0]).toBe(12);
    now[0] = 525;
    v.update(26, 14, 100);
    expect(v.height[0]).toBe(15.5);
    v.update(26, 14, 0);
    expect(v.height[0]).toBe(26);
    v.reset(12);
    expect(v.height[0]).toBe(12);
  });
});
