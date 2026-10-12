import { Mulberry32 } from "@game/shared";
import { describe, expect, it } from "vitest";
import type { LogLevel, LoopHost } from "../../src/match/host";
import { MAX_CATCHUP_TICKS, startMatchLoop } from "../../src/match/loop";

/** A host whose clock only moves when the test says, holding at most one scheduled wake. */
class FakeHost implements LoopHost {
  time = 0;
  pending: (() => void) | null = null;
  requested = 0;
  schedules = 0;
  readonly logs: [LogLevel, string][] = [];

  now(): number {
    return this.time;
  }

  schedule(cb: () => void, ms: number): void {
    expect(this.pending).toBeNull();
    expect(ms).toBeGreaterThanOrEqual(0);
    this.pending = cb;
    this.requested = ms;
    this.schedules++;
  }

  log(level: LogLevel, msg: string): void {
    this.logs.push([level, msg]);
  }

  /** Moves the clock to `at` and runs the pending wake. */
  fireAt(at: number): void {
    const cb = this.pending;
    if (cb === null) throw new Error("nothing scheduled");
    this.pending = null;
    this.time = at;
    cb();
  }

  /**
   * A wake at `at` that comes a tick or more late: the loop runs nothing and yields (asks for a
   * 0 ms wake), then that wake, at the same time, runs the ticks.
   */
  fireLateAt(at: number, ticks: Counter | null = null): void {
    const before = ticks?.ticks ?? 0;
    this.fireAt(at);
    expect(ticks?.ticks ?? 0).toBe(before);
    expect(this.requested).toBe(0);
    this.fireAt(at);
  }
}

class Counter {
  ticks = 0;
  tick(): void {
    this.ticks++;
  }
}

describe("match loop", () => {
  it("runs 60 ticks per simulated second under uneven, early and late wakes", () => {
    const host = new FakeHost();
    const counter = new Counter();
    const loop = startMatchLoop(counter, host);
    const rng = new Mulberry32(0x100f);
    let wakes = 0;
    for (let second = 1; second <= 10; second++) {
      const end = second * 1000;
      // Wakes from 4 ms early to 12 ms late against what the loop asked for, in whole and
      // fractional milliseconds, never past the end of the second.
      while (host.time + host.requested + 12 < end) {
        const jitter = rng.nextFloat() * 16 - 4;
        host.fireAt(Math.max(host.time, host.time + host.requested + jitter));
        wakes++;
      }
      host.fireAt(end);
      wakes++;
      expect(counter.ticks).toBe(60 * second);
    }
    expect(loop.stats.ticks).toBe(600);
    expect(loop.stats.dropped).toBe(0);
    expect(loop.stats.wakes).toBe(wakes);
    expect(host.logs).toEqual([]);
  });

  it("ticks on every wake that comes exactly when asked, from any start time", () => {
    // A simulated clock that jumps to the requested time (net tests, bots): a due count by floor
    // alone comes out one short at some ticks and re-arms with 0 ms forever.
    for (const t0 of [0, 0.1, 12345.678, 1e6 + 0.3, 987654321.123, 1e9 + 0.77]) {
      const host = new FakeHost();
      host.time = t0;
      const counter = new Counter();
      const loop = startMatchLoop(counter, host);
      while (counter.ticks < 600 && loop.stats.wakes < 1200) {
        host.fireAt(host.time + host.requested);
      }
      expect(counter.ticks).toBe(600);
      expect(loop.stats.wakes).toBeLessThanOrEqual(605);
      expect(host.time - t0).toBeCloseTo(10000, 6);
      expect(host.logs).toEqual([]);
    }
  });

  it("asks to be woken when the next tick is due", () => {
    const host = new FakeHost();
    const counter = new Counter();
    startMatchLoop(counter, host);
    expect(host.requested).toBeCloseTo(1000 / 60, 9);
    host.fireAt(10);
    expect(counter.ticks).toBe(0);
    expect(host.requested).toBeCloseTo(1000 / 60 - 10, 9);
    host.fireAt(25);
    expect(counter.ticks).toBe(1);
    expect(host.requested).toBeCloseTo((2 * 1000) / 60 - 25, 9);
  });

  it("after a 1 s stall runs 5 ticks, drops the rest with one warning, then keeps time", () => {
    const host = new FakeHost();
    const counter = new Counter();
    const loop = startMatchLoop(counter, host);
    host.fireLateAt(1000, counter);
    expect(counter.ticks).toBe(MAX_CATCHUP_TICKS);
    expect(loop.stats.dropped).toBe(60 - MAX_CATCHUP_TICKS);
    expect(host.logs).toHaveLength(1);
    expect(host.logs[0]?.[0]).toBe("warn");
    // Less than one tick is left over: the next tick is due a full period later.
    expect(host.requested).toBeCloseTo(1000 / 60, 9);
    for (let i = 1; i <= 60; i++) host.fireAt(1000 + (i * 1000) / 60 + 0.001);
    expect(counter.ticks).toBe(MAX_CATCHUP_TICKS + 60);
    expect(host.logs).toHaveLength(1);
  });

  it("logs once per stall", () => {
    const host = new FakeHost();
    const counter = new Counter();
    startMatchLoop(counter, host);
    host.fireLateAt(500, counter);
    host.fireAt(500 + 1000 / 60 + 0.001);
    host.fireLateAt(2000, counter);
    expect(counter.ticks).toBe(2 * MAX_CATCHUP_TICKS + 1);
    expect(host.logs.map(([level]) => level)).toEqual(["warn", "warn"]);
  });

  it("a wake a tick or more late yields once, so input that came meanwhile reaches its ticks", () => {
    // Node runs a due timer before the socket reads that piled up during a stall: the yield (a
    // 0 ms wake) lets the host deliver them before the catch-up ticks poll the transports.
    const host = new FakeHost();
    let inputs = 0;
    const seen: number[] = [];
    const loop = startMatchLoop({ tick: () => seen.push(inputs) }, host);
    host.fireAt(20);
    expect(seen).toEqual([0]);
    // 70 ms late: ticks 2–5 are due. Nothing runs before the host has had its turn.
    host.fireAt(90);
    expect(seen).toEqual([0]);
    expect(host.requested).toBe(0);
    expect(loop.stats.yields).toBe(1);
    inputs = 1; // what the host delivered between the two wakes
    host.fireAt(90);
    expect(seen).toEqual([0, 1, 1, 1, 1]);
    expect(host.requested).toBeCloseTo((6 * 1000) / 60 - 90, 9);
    // The second wake never yields again, even when the yield itself ran late.
    host.fireAt(140);
    host.fireAt(160);
    expect(seen).toHaveLength(9);
    expect(loop.stats.yields).toBe(2);
    expect(host.logs).toEqual([]);
  });

  it("a wake less than a tick late runs its one tick at once", () => {
    const host = new FakeHost();
    const counter = new Counter();
    const loop = startMatchLoop(counter, host);
    // Each wake 16 ms after its tick was due: one tick owed each time, no yield.
    for (let k = 1; k <= 60; k++) {
      host.fireAt((k * 1000) / 60 + 16);
      expect(counter.ticks).toBe(k);
    }
    expect(loop.stats.yields).toBe(0);
  });

  it("ignores a clock that steps back", () => {
    const host = new FakeHost();
    const counter = new Counter();
    startMatchLoop(counter, host);
    host.fireLateAt(50, counter);
    expect(counter.ticks).toBe(3);
    host.fireAt(40);
    expect(counter.ticks).toBe(3);
    // Time is counted from the start, so the fourth tick is still due at 4 periods.
    host.fireAt((4 * 1000) / 60 - 0.001);
    expect(counter.ticks).toBe(3);
    host.fireAt((4 * 1000) / 60 + 0.001);
    expect(counter.ticks).toBe(4);
  });

  it("stops: no tick and no re-arm after stop()", () => {
    const host = new FakeHost();
    const counter = new Counter();
    const loop = startMatchLoop(counter, host);
    host.fireAt(20);
    expect(counter.ticks).toBe(1);
    loop.stop();
    expect(loop.isRunning).toBe(false);
    const schedules = host.schedules;
    host.fireAt(1000);
    expect(counter.ticks).toBe(1);
    expect(host.schedules).toBe(schedules);
    expect(host.pending).toBeNull();
  });

  it("a restart while a wake is pending keeps one wake chain and counts from the restart", () => {
    const host = new FakeHost();
    const counter = new Counter();
    const loop = startMatchLoop(counter, host);
    host.fireAt(20);
    loop.stop();
    host.time = 25;
    loop.start();
    // FakeHost holds one wake at a time and throws on a second schedule.
    expect(host.schedules).toBe(2);
    host.fireAt(30);
    expect(counter.ticks).toBe(1);
    while (host.time < 1025) host.fireAt(Math.min(1025, host.time + host.requested));
    expect(counter.ticks).toBe(61);
    expect(host.schedules).toBe(loop.stats.wakes + 1);
  });

  it("a restart from inside a tick keeps one wake chain", () => {
    const host = new FakeHost();
    let ticks = 0;
    const loop = startMatchLoop(
      {
        tick() {
          ticks++;
          if (ticks === 2) {
            loop.stop();
            loop.start();
          }
        },
      },
      host,
    );
    // Three ticks due; the second restarts at time 60, so the third is not run now.
    host.fireLateAt(60);
    expect(ticks).toBe(2);
    expect(host.pending).not.toBeNull();
    expect(host.requested).toBeCloseTo(1000 / 60, 9);
    host.fireAt(60 + 1000 / 60);
    expect(ticks).toBe(3);
    expect(host.schedules).toBe(loop.stats.wakes + 1);
  });

  it("start() on a running loop changes nothing", () => {
    const host = new FakeHost();
    const counter = new Counter();
    const loop = startMatchLoop(counter, host);
    host.fireLateAt(40, counter);
    expect(counter.ticks).toBe(2);
    const schedules = host.schedules;
    loop.start();
    expect(host.schedules).toBe(schedules);
    host.fireAt(50);
    expect(counter.ticks).toBe(3);
  });

  it("measures the time spent in ticks: the sum and the longest wake", () => {
    const host = new FakeHost();
    const loop = startMatchLoop(
      {
        tick() {
          host.time += 2;
        },
      },
      host,
    );
    host.fireAt(20);
    host.fireLateAt(60);
    host.fireAt(68);
    expect(loop.stats.ticks).toBe(4);
    expect(loop.stats.busyMs[0]).toBeCloseTo(8, 9);
    expect(loop.stats.busyMs[1]).toBeCloseTo(4, 9);
  });

  it("stops between two ticks of one wake when a tick calls stop()", () => {
    const host = new FakeHost();
    let ticks = 0;
    const loop = startMatchLoop(
      {
        tick() {
          ticks++;
          if (ticks === 2) loop.stop();
        },
      },
      host,
    );
    host.fireLateAt(80);
    expect(ticks).toBe(2);
    expect(host.pending).toBeNull();
    expect(host.logs).toEqual([]);
  });
});
