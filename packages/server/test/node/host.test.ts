import { PassThrough } from "node:stream";
import { TICK_RATE } from "@game/shared";
import { describe, expect, it } from "vitest";
import { LoopStats, MatchLoop } from "../../src/match/loop";
import type { Match } from "../../src/match/match";
import { TickHistogram } from "../../src/match/tickStats";
import { startConsole } from "../../src/node/console";
import { createNodeHost, type PassClock, type ServerMatch, TimedPass } from "../../src/node/host";
import type { JsonLog } from "../../src/node/log";
import { until } from "./wsClient";

function fakeMatch(name: string, order: string[], tick: () => void = () => {}): ServerMatch {
  const match = {
    tick: () => {
      order.push(name);
      tick();
    },
  } as unknown as Match;
  return { name, match, ticks: new TickHistogram() };
}

/** A clock that moves only when the test (or a fake match's tick) moves it. */
class FakeClock implements PassClock {
  ms = 0;
  cpuUs = 0;
  now(): number {
    return this.ms;
  }
  cpuMicros(): number {
    return this.cpuUs;
  }
}

describe("TimedPass", () => {
  it("ticks every match in order, timing each and the whole pass", () => {
    const order: string[] = [];
    const a = fakeMatch("a", order);
    const b = fakeMatch("b", order);
    const pass = new TimedPass([a, b], () => {});
    pass.tick();
    pass.tick();
    expect(order).toEqual(["a", "b", "a", "b"]);
    expect([a.ticks.run.count, b.ticks.run.count, pass.ticks.run.count]).toEqual([2, 2, 2]);
    expect(pass.passes).toBe(2);
  });

  it("records each match's own time and the whole pass in whole microseconds", () => {
    const clock = new FakeClock();
    clock.ms = 5000;
    const order: string[] = [];
    // Match a takes 1.25 ms, b 2.5 ms; between passes the loop idles 10 ms.
    const a = fakeMatch("a", order, () => {
      clock.ms += 1.25;
    });
    const b = fakeMatch("b", order, () => {
      clock.ms += 2.5;
    });
    const pass = new TimedPass([a, b], () => {}, clock);
    for (let i = 0; i < 3; i++) {
      pass.tick();
      clock.ms += 10;
    }
    expect([a.ticks.run.count, a.ticks.run.maxUs, a.ticks.run.percentileUs(50)]).toEqual([
      3, 1250, 1250,
    ]);
    expect([b.ticks.run.maxUs, b.ticks.run.percentileUs(50)]).toEqual([2500, 2500]);
    expect([pass.ticks.run.maxUs, pass.ticks.run.percentileUs(50)]).toEqual([3750, 3750]);
  });

  it("reports CPU milliseconds per wall second over each closed second", () => {
    const clock = new FakeClock();
    const pass = new TimedPass([fakeMatch("main", [])], () => {}, clock);
    for (let i = 0; i < TICK_RATE; i++) {
      clock.ms += 1000 / TICK_RATE;
      // 0.4 s of CPU in the 1 s: 400 ms per wall second.
      clock.cpuUs += 400_000 / TICK_RATE;
      pass.tick();
    }
    expect(pass.cpuMsPerWallS).toBeCloseTo(400, 6);
    for (let i = 0; i < TICK_RATE; i++) {
      clock.ms += 2000 / TICK_RATE;
      clock.cpuUs += 500_000 / TICK_RATE;
      pass.tick();
    }
    expect(pass.cpuMsPerWallS).toBeCloseTo(250, 6);
  });

  it("closes the 1 s windows every TICK_RATE passes", () => {
    const m = fakeMatch("main", []);
    const pass = new TimedPass([m], () => {});
    for (let i = 0; i < TICK_RATE - 1; i++) pass.tick();
    expect(m.ticks.second.count).toBe(TICK_RATE - 1);
    pass.tick();
    expect(m.ticks.second.count).toBe(0);
    expect(pass.ticks.second.count).toBe(0);
    expect(m.ticks.run.count).toBe(TICK_RATE);
    expect(pass.cpuMsPerWallS).toBeGreaterThanOrEqual(0);
  });

  it("logs a loop drop once as tick_drop, naming every match", () => {
    const logged: [string, string, unknown][] = [];
    const log: JsonLog = (lvl, ev, fields) => logged.push([lvl, ev, fields]);
    const pass = new TimedPass([fakeMatch("a", []), fakeMatch("b", [])], log);
    const stats = new LoopStats();
    pass.loopStats = stats;
    pass.tick();
    stats.dropped = 7;
    pass.tick();
    pass.tick();
    expect(logged).toEqual([
      ["warn", "tick_drop", { dropped: 7, totalDropped: 7, matches: ["a", "b"] }],
    ]);
  });
});

describe("a loop drop on the Node host", () => {
  it("is one tick_drop line naming every match, as the loop falls behind", () => {
    const logged: [string, string, unknown][] = [];
    const log: JsonLog = (lvl, ev, fields) => logged.push([lvl, ev, fields]);
    const clock = new FakeClock();
    let stall = 0;
    const a = fakeMatch("a", [], () => {
      clock.ms += stall;
      stall = 0;
    });
    const pass = new TimedPass([a, fakeMatch("b", [])], log, clock);
    let wake: (() => void) | null = null;
    // The real Node host's log wiring, on the fake clock and a manual timer.
    const host = {
      ...createNodeHost(log, pass),
      now: () => clock.ms,
      schedule: (cb: () => void) => {
        wake = cb;
      },
    };
    const loop = new MatchLoop(pass, host);
    pass.loopStats = loop.stats;
    loop.start();
    const step = (ms: number) => {
      clock.ms += ms;
      const cb = wake as (() => void) | null;
      wake = null;
      cb?.();
    };
    for (let i = 0; i < 10; i++) step(1000 / TICK_RATE);
    // One tick stalls 300 ms: the loop catches up 5 ticks and drops the rest.
    stall = 300;
    for (let i = 0; i < 10; i++) step(1000 / TICK_RATE);
    expect(loop.stats.dropped).toBeGreaterThan(0);
    expect(logged).toEqual([
      [
        "warn",
        "tick_drop",
        { dropped: loop.stats.dropped, totalDropped: loop.stats.dropped, matches: ["a", "b"] },
      ],
    ]);
    // Other loop lines still go out as ev "loop".
    host.log("info", "something else");
    expect(logged.at(-1)).toEqual(["info", "loop", { msg: "something else" }]);
  });
});

describe("createNodeHost", () => {
  it("is monotonic, schedules with setTimeout and logs as ev loop", async () => {
    const logged: unknown[] = [];
    const host = createNodeHost((lvl, ev, fields) => logged.push([lvl, ev, fields]));
    const t0 = host.now();
    let fired = false;
    host.schedule(() => {
      fired = true;
    }, 0.4);
    await until(() => fired, "the scheduled callback");
    expect(host.now()).toBeGreaterThanOrEqual(t0);
    host.log("warn", "fell behind");
    expect(logged).toEqual([["warn", "loop", { msg: "fell behind" }]]);
  });
});

describe("startConsole", () => {
  it("hands each input line over until stopped", async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const stop = startConsole(input, (l) => lines.push(l));
    input.write("set pm_gravity 400\nstatus\r\npartial");
    await until(() => lines.length === 2, "two lines");
    stop();
    input.write("\nlate\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(lines).toEqual(["set pm_gravity 400", "status"]);
  });
});
