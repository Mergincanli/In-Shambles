import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCEL_AIR,
  accelerate,
  angleVectors,
  BUTTON_JUMP,
  BUTTON_WALK,
  cmdScale,
  copyPlayerState,
  copyUserCmd,
  degreesToU16,
  ENTITY_NONE,
  ENTITY_WORLD,
  PlayerState,
  PMEV_JUMP,
  PMEV_LAND,
  PMF_GROUNDED,
  UserCmd,
  vec3,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { DETERMINISTIC_MATH_RULES } from "../../src/code/deterministicMath";
import { scanSource } from "../../src/code/scan";
import { fromRoot } from "../../src/paths";
import { HoldInput, HopForward, idle, PhasedInput, StrafeHop } from "../../src/scenarios/bots";
import { anchorYawU16, courseAnchor, courseAnchors, loadCourse } from "../../src/scenarios/course";
import {
  airtime,
  apex,
  eventsOf,
  landingSpeeds,
  maxHorizontalSpeed,
  measuredLine,
  settledIndex,
  speedCurve,
} from "../../src/scenarios/metrics";
import {
  type CmdSource,
  placeAtAnchor,
  placePlayer,
  SCENARIO_STAMINA,
  ScenarioRecord,
  ScenarioRunner,
} from "../../src/scenarios/runner";

// The scenario harness behind the MV tests and the feel report (D-025, M2 design §1).

const course = loadCourse("movement_lab");
const runner = new ScenarioRunner(course.world);

describe("scenario course loading", () => {
  it("caches each course and finds anchors by name, with their yaw", () => {
    expect(loadCourse("movement_lab")).toBe(course);
    const sw = courseAnchor(course, "open_sw");
    expect(sw.yawDegrees).toBe(45);
    expect(anchorYawU16(sw)).toBe(degreesToU16(45));
    expect(courseAnchors(course.cmap).get("runway_start")).toHaveLength(1);
  });

  it("throws for an anchor the course lacks", () => {
    expect(() => courseAnchor(course, "no_such_anchor")).toThrow(/no_such_anchor.*found 0/);
  });
});

describe("ScenarioRunner", () => {
  it("records the start as state 0 and the state after tick i as state i", () => {
    const start = courseAnchor(course, "runway_start");
    const ps = placeAtAnchor(new PlayerState(), start);
    const before = copyPlayerState(new PlayerState(), ps);
    const record = runner.run(ps, new HoldInput(0), 10);
    expect(record.count).toBe(11);
    expect(record.ticksRun).toBe(10);
    expect([record.x(0), record.y(0), record.z(0)]).toEqual([...before.origin]);
    expect(record.x(10)).toBe(ps.origin[0]);
    expect(record.velocity[30]).toBe(ps.velocity[0]);
    expect(record.flags[10]).toBe(ps.flags);
    expect(record.viewYaw[10]).toBe(0);
  });

  it("numbers events by the tick that emitted them", () => {
    const ps = placeAtAnchor(new PlayerState(), courseAnchor(course, "runway_start"));
    const record = runner.run(ps, new HopForward(0, { runUpTicks: 3, hops: 1, forward: 0 }), 60);
    const jump = eventsOf(record, PMEV_JUMP);
    expect(jump).toEqual([{ tick: 4, value: 0 }]);
    expect(record.grounded(3)).toBe(true);
    expect(record.grounded(4)).toBe(false);
    const land = eventsOf(record, PMEV_LAND);
    expect(land).toHaveLength(1);
    expect(record.grounded((land[0]?.tick as number) - 1)).toBe(false);
    expect(record.grounded(land[0]?.tick as number)).toBe(true);
  });

  it("is deterministic: two runs give the same record", () => {
    const run = () => {
      const start = courseAnchor(course, "open_sw");
      const ps = placeAtAnchor(new PlayerState(), start);
      return runner.run(ps, new HopForward(anchorYawU16(start), { hops: 3 }), 240);
    };
    const a = run();
    const b = run();
    expect(b.origin).toEqual(a.origin);
    expect(b.velocity).toEqual(a.velocity);
    expect(b.flags).toEqual(a.flags);
    expect(b.eventValue.subarray(0, b.eventCount)).toEqual(a.eventValue.subarray(0, a.eventCount));
  });

  it("clears a record for reuse", () => {
    const start = courseAnchor(course, "runway_start");
    const ps = placeAtAnchor(new PlayerState(), start);
    const record = runner.run(ps, new HopForward(0, { runUpTicks: 1, hops: 1 }), 60);
    expect(record.eventCount).toBeGreaterThan(0);
    record.clear();
    expect([record.count, record.eventCount, record.eventsDropped, record.ticksRun]).toEqual([
      0, 0, 0, 0,
    ]);
    record.push(placeAtAnchor(ps, start));
    runner.continue(ps, new HoldInput(0), 5, record);
    expect(record.count).toBe(6);
    expect(record.eventCount).toBe(0);
  });

  it("continues a record, and stops at its capacity", () => {
    const start = courseAnchor(course, "runway_start");
    const one = runner.run(placeAtAnchor(new PlayerState(), start), new HoldInput(0), 20);
    const ps = placeAtAnchor(new PlayerState(), start);
    const two = runner.run(ps, new HoldInput(0), 10, 20);
    expect(two.count).toBe(11);
    runner.continue(ps, new HoldInput(0), 100, two);
    expect(two.count).toBe(21);
    expect(two.origin).toEqual(one.origin);
    expect(two.velocity).toEqual(one.velocity);
  });

  it("sanitizes the bots' cmds as the server does", () => {
    const wild: CmdSource = {
      next(cmd: UserCmd) {
        cmd.forward = 1000;
        cmd.right = 0;
        cmd.up = 0;
        cmd.buttons = 0xffff & ~BUTTON_JUMP;
        cmd.yaw = 0x12345;
        cmd.pitch = 0;
        cmd.weaponSlot = 99;
      },
    };
    const ps = placeAtAnchor(new PlayerState(), courseAnchor(course, "runway_start"));
    runner.run(ps, wild, 1);
    expect(runner.cmd.forward).toBe(127);
    expect(runner.cmd.yaw).toBe(0x2345);
    expect(runner.cmd.tick).toBe(1);
  });

  it("places players at rest with full stamina, grounded on the world or airborne", () => {
    const ps = new PlayerState();
    ps.velocity.fill(5);
    placePlayer(ps, [1, 2, 3], 0x1_0001);
    expect([...ps.origin, ...ps.velocity]).toEqual([1, 2, 3, 0, 0, 0]);
    expect([ps.viewYaw, ps.flags, ps.groundEntity]).toEqual([1, PMF_GROUNDED, ENTITY_WORLD]);
    expect(ps.stamina).toBe(SCENARIO_STAMINA);
    placePlayer(ps, [1, 2, 3], 0, false);
    expect([ps.flags, ps.groundEntity]).toEqual([0, ENTITY_NONE]);
  });
});

describe("bots", () => {
  const ps = new PlayerState();
  const cmd = new UserCmd();

  it("HoldInput holds its input, and lets go for good at the release line", () => {
    const bot = new HoldInput(77, { buttons: BUTTON_WALK, release: { axis: 1, at: 10 } });
    ps.origin.set([0, 9, 0]);
    bot.next(cmd, ps);
    expect([cmd.forward, cmd.buttons, cmd.yaw]).toEqual([127, BUTTON_WALK, 77]);
    ps.origin[1] = 10;
    bot.next(cmd, ps);
    expect([cmd.forward, cmd.buttons, cmd.yaw, bot.released]).toEqual([0, 0, 77, true]);
    ps.origin[1] = 0;
    bot.next(cmd, ps);
    expect(cmd.forward).toBe(0);
    idle(5).next(cmd, ps);
    expect([cmd.forward, cmd.right, cmd.buttons, cmd.yaw]).toEqual([0, 0, 0, 5]);
  });

  it("HopForward presses jump only on grounded ticks after its run-up, up to its hop count", () => {
    const bot = new HopForward(0, { runUpTicks: 2, hops: 2 });
    const pressed: number[] = [];
    for (const grounded of [true, true, true, false, true, true, true]) {
      ps.flags = grounded ? PMF_GROUNDED : 0;
      bot.next(cmd, ps);
      pressed.push(cmd.buttons & BUTTON_JUMP);
      expect(cmd.forward).toBe(127);
    }
    expect(pressed).toEqual([0, 0, BUTTON_JUMP, 0, BUTTON_JUMP, 0, 0]);
    expect(bot.jumps).toBe(2);
  });

  it("PhasedInput plays its phases by tick count, carries yaw and pitch over and holds the last", () => {
    const bot = new PhasedInput([
      { ticks: 2, forward: 127, yaw: 100, pitch: 5 },
      { ticks: 1, right: -127, up: 64, buttons: BUTTON_JUMP },
      { ticks: 1, forward: -127, yaw: 70000 },
    ]);
    const seen: number[][] = [];
    for (let i = 0; i < 6; i++) {
      bot.next(cmd, ps);
      seen.push([cmd.forward, cmd.right, cmd.up, cmd.buttons, cmd.yaw, cmd.pitch]);
    }
    expect(seen).toEqual([
      [127, 0, 0, 0, 100, 5],
      [127, 0, 0, 0, 100, 5],
      [0, -127, 64, BUTTON_JUMP, 100, 5],
      [-127, 0, 0, 0, 70000 & 0xffff, 5],
      [-127, 0, 0, 0, 70000 & 0xffff, 5],
      [-127, 0, 0, 0, 70000 & 0xffff, 5],
    ]);
    expect(bot.currentPhase).toBe(2);
    expect(() => new PhasedInput([])).toThrow(/at least one phase/);
    for (const ticks of [0, -1, 1.9, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, 2 ** 32 + 2]) {
      expect(() => new PhasedInput([{ ticks }]), String(ticks)).toThrow(/integer ticks/);
    }
    expect(() => new PhasedInput([{ ticks: 0x7fffffff }])).not.toThrow();
  });

  it("StrafeHop's yaw is a maximum of one tick's air acceleration", () => {
    const bot = new StrafeHop(0, runner.params, runner.dt, { hops: 1 });
    const gain = (yaw: number, vx: number, vy: number) => {
      const p = new PlayerState();
      p.velocity.set([vx, vy, 100]);
      const c = new UserCmd();
      c.forward = 127;
      c.right = 127;
      c.yaw = yaw;
      // Airborne high above the open floor: one air move, nothing to touch.
      p.origin.set([0, -1024, 2000]);
      runner.run(p, { next: (out: UserCmd) => copyUserCmd(out, c) }, 1);
      return Math.sqrt(p.velocity[0] * p.velocity[0] + p.velocity[1] * p.velocity[1]);
    };
    for (const [vx, vy] of [
      [320, 0],
      [0, -400],
      [-350, 260],
    ] as const) {
      const best = bot.bestYaw(vec3(vx, vy, 100));
      const s = gain(best, vx, vy);
      expect(s).toBeGreaterThan(Math.sqrt(vx * vx + vy * vy));
      for (const d of [-512, -16, -1, 1, 16, 512]) {
        expect(gain((best + d) & 0xffff, vx, vy), `${vx}, ${vy} yaw ${best}+${d}`).toBeLessThan(
          s + 1e-9,
        );
      }
    }
  });

  it("StrafeHop's yaw is the best of all 65536, by the shared air acceleration unquantized", () => {
    // An independent oracle: the view basis from angleVectors, flattened and normalized as the
    // air move does, cmdScale and the shared accelerate, with no pmove and no quantization, so a
    // yaw a fraction of a u16 step off the optimum (about 0.4 (u/s)² of |v'|² at 400 u/s) shows.
    const params = runner.params;
    const f = vec3();
    const r = vec3();
    const u = vec3();
    const axes = vec3();
    const wish = vec3();
    const v = vec3();
    const speed2After = (yaw: number, side: number, vx: number, vy: number) => {
      const c = new UserCmd();
      c.forward = 127;
      c.right = side * 127;
      cmdScale(axes, c, 0, false, params);
      angleVectors(yaw, 0, f, r, u);
      const fl = Math.sqrt(f[0] * f[0] + f[1] * f[1]);
      const rl = Math.sqrt(r[0] * r[0] + r[1] * r[1]);
      wish[0] = (f[0] / fl) * axes[0] + (r[0] / rl) * axes[1];
      wish[1] = (f[1] / fl) * axes[0] + (r[1] / rl) * axes[1];
      wish[2] = 0;
      v.set([vx, vy, 0]);
      accelerate(v, wish, ACCEL_AIR, params, runner.dt);
      return v[0] * v[0] + v[1] * v[1];
    };
    for (const side of [1, -1] as const) {
      const bot = new StrafeHop(0, params, runner.dt, { hops: 1, firstSide: side });
      for (const [vx, vy] of [
        [320, 0],
        [0, -400],
        [-350, 260],
        [612.5, 401.25],
      ] as const) {
        let max = 0;
        for (let a = 0; a < 65536; a++) max = Math.max(max, speed2After(a, side, vx, vy));
        const got = speed2After(bot.bestYaw(vec3(vx, vy, 0)), side, vx, vy);
        expect(got, `side ${side}, v (${vx}, ${vy})`).toBeGreaterThanOrEqual(max - 1e-9 * max);
      }
    }
  });

  it("StrafeHop gains speed on every hop and alternates its strafe side", () => {
    const start = courseAnchor(course, "open_sw");
    const ps = placeAtAnchor(new PlayerState(), start);
    const bot = new StrafeHop(anchorYawU16(start), runner.params, runner.dt, { hops: 4 });
    const sides: number[] = [];
    const record = runner.run(
      ps,
      {
        next(cmd: UserCmd, p: PlayerState) {
          bot.next(cmd, p);
          if ((cmd.buttons & BUTTON_JUMP) !== 0) sides.push(cmd.right);
        },
      },
      60 + 4 * 45,
    );
    const curve = landingSpeeds(record);
    expect(curve).toHaveLength(4);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i] as number).toBeGreaterThan(curve[i - 1] as number);
    }
    expect(curve[0] as number).toBeGreaterThan(330);
    expect(sides).toEqual([127, -127, 127, -127]);
  });

  it("use exact math only (D-016), so a scripted run is the same on every machine", () => {
    const dir = fromRoot("packages", "tools", "src", "scenarios");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files).toEqual(expect.arrayContaining(["bots.ts", "runner.ts", "course.ts"]));
    for (const f of ["bots.ts", "runner.ts"]) {
      const { code } = scanSource(readFileSync(join(dir, f), "utf8"));
      const hits = DETERMINISTIC_MATH_RULES.filter(([, re]) => re.test(code)).map(([l]) => l);
      expect(hits, f).toEqual([]);
    }
  });
});

describe("scenario metrics", () => {
  /** A record with the given horizontal speeds along x and heights. */
  function synthetic(speeds: number[], zs: number[] = speeds.map(() => 0)): ScenarioRecord {
    const r = new ScenarioRecord(speeds.length - 1, 0.5);
    const ps = new PlayerState();
    for (let i = 0; i < speeds.length; i++) {
      ps.velocity[0] = speeds[i] as number;
      ps.origin[2] = zs[i] as number;
      r.push(ps);
    }
    return r;
  }

  it("settledIndex is the start of the final run within tolerance", () => {
    const r = synthetic([0, 100, 319.6, 321, 320.2, 319.5, 320]);
    expect(settledIndex(r, 320, 0.5)).toBe(4);
    expect(settledIndex(r, 320, 1)).toBe(2);
    expect(settledIndex(synthetic([0, 320, 0]), 320, 0.5)).toBe(-1);
  });

  it("speed curve, max speed and apex", () => {
    const r = synthetic([3, 4, 5, 2], [10, 12, 15, 11]);
    expect([...speedCurve(r)]).toEqual([3, 4, 5, 2]);
    expect(maxHorizontalSpeed(r)).toBe(5);
    expect(maxHorizontalSpeed(r, 3)).toBe(2);
    expect(apex(r)).toEqual({ index: 2, height: 5 });
  });

  it("airtime counts both the jump tick and the landing tick", () => {
    const r = synthetic([0, 0]);
    expect(airtime(r, { tick: 1, value: 0 }, { tick: 41, value: 262.5 })).toBe(20.5);
  });

  it("formats the measured-vs-target line", () => {
    expect(measuredLine("MV-01", "run cap", "320 u/s", "320 ± 0.5 u/s")).toBe(
      "MV-01 run cap: measured 320 u/s, target 320 ± 0.5 u/s",
    );
  });
});
