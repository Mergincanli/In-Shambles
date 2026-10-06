import { describe, expect, it } from "vitest";
import { msToTicks, secondsToTicks, TICK_DT, TICK_RATE, ticksToMs } from "../src/time";

describe("tick time", () => {
  it("runs at 60 Hz with one dt constant (D-004)", () => {
    expect(TICK_RATE).toBe(60);
    expect(TICK_DT).toBe(1 / 60);
  });

  it.each([
    [0, 0],
    [1, 60],
    [0.5, 30],
    [0.25, 15],
    [1 / 120, 1],
    [8.5, 510],
  ])("secondsToTicks(%f) = %i", (seconds, ticks) => {
    expect(secondsToTicks(seconds)).toBe(ticks);
  });

  it.each([
    [0, 0],
    [1000, 60],
    [200, 12],
    [16, 1],
    [8, 0],
    [9, 1],
    [100, 6],
  ])("msToTicks(%i) = %i", (ms, ticks) => {
    expect(msToTicks(ms)).toBe(ticks);
  });

  it("converts ticks back to milliseconds", () => {
    expect(ticksToMs(60)).toBe(1000);
    expect(ticksToMs(12)).toBe(200);
    expect(msToTicks(ticksToMs(12345))).toBe(12345);
  });

  it("never returns -0 for tiny negative durations", () => {
    expect(Object.is(secondsToTicks(-1 / 120), 0)).toBe(true);
    expect(Object.is(msToTicks(-1), 0)).toBe(true);
    expect(Object.is(msToTicks(-0), 0)).toBe(true);
    expect(secondsToTicks(-1)).toBe(-60);
  });

  it("returns integers", () => {
    for (let ms = 0; ms < 5000; ms += 7) expect(Number.isInteger(msToTicks(ms))).toBe(true);
  });
});
