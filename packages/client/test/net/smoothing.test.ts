import { vec3 } from "@game/shared";
import { describe, expect, it } from "vitest";
import { RenderOffset } from "../../src/net/smoothing";
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
