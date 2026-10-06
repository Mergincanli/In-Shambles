import { describe, expect, it } from "vitest";
import { degreesToU16, quantizeOrigin, quantizeVelocity } from "../../../src/math/quant";
import { PMEV_JUMP, PMEV_LAND, PMEV_STEP } from "../../../src/sim/events";
import {
  copyPlayerState,
  PlayerState,
  PMF_GROUNDED,
  PMF_JUMP_HELD,
  playerStateEquals,
} from "../../../src/sim/playerState";
import { PmoveTraceLog, PmoveTraceRecord } from "../../../src/sim/pmove/debug";
import { PmoveParams } from "../../../src/sim/pmove/params";
import { lastPmoveSnap, pmove } from "../../../src/sim/pmove/pmove";
import { BUTTON_JUMP, UserCmd } from "../../../src/sim/usercmd";
import { TICK_DT } from "../../../src/time";
import { SNAP_ROUNDED } from "../../../src/world/trace";
import { box, cmd, floorBrush, player, restZ, run } from "../../helpers/pmoveWorld";
import { worldOf } from "../../helpers/traceWorld";

// The pmove pipeline (docs/03 §3, M2 design §2, D-023).

const flat = worldOf(floorBrush());

/** One jump tick, then nothing: the apex above the start and the tick of the LAND event. */
function jumpArc(dt: number) {
  const ps = player(0, 0);
  const ticks = Math.round(1.5 / dt);
  const { z, events } = run(ps, flat, (t) => cmd({ buttons: t === 0 ? BUTTON_JUMP : 0 }), ticks, {
    dt,
  });
  return { apex: Math.max(...z) - restZ(0), events, ps };
}

describe("pmove pipeline", () => {
  it("takes the view angles from the cmd and releases PMF_JUMP_HELD with the button", () => {
    const ps = player(0, 0);
    ps.flags |= PMF_JUMP_HELD;
    const c = cmd({ yaw: 12345, pitch: 0xffff - 99 });
    pmove(ps, c, flat, new PmoveParams(), TICK_DT, null, null);
    expect(ps.viewYaw).toBe(12345);
    expect(ps.viewPitch).toBe(0xffff - 99);
    expect(ps.flags & PMF_JUMP_HELD).toBe(0);
    // Held, the flag stays (no jump: it was already held).
    ps.flags |= PMF_JUMP_HELD;
    pmove(ps, cmd({ buttons: BUTTON_JUMP }), flat, new PmoveParams(), TICK_DT, null, null);
    expect(ps.flags & PMF_JUMP_HELD).toBe(PMF_JUMP_HELD);
    expect(ps.flags & PMF_GROUNDED).toBe(PMF_GROUNDED);
  });

  it("ends every tick snapped and quantized", () => {
    const ps = player(0.3, -7.77);
    ps.velocity.set([123.456, -98.7654, 0]);
    run(ps, flat, (t) => cmd({ forward: 100, right: -40, yaw: 1000 * t }), 30, {
      each: () => {
        for (let k = 0; k < 3; k++) {
          expect(quantizeOrigin(ps.origin[k] as number)).toBe(ps.origin[k]);
          expect(quantizeVelocity(ps.velocity[k] as number)).toBe(ps.velocity[k]);
        }
        expect(lastPmoveSnap()).toBe(SNAP_ROUNDED);
      },
    });
  });

  it.each([TICK_DT, 1 / 120])("jumps to an apex of 45.56 ± 0.5 u at dt %f (MV-04 basis)", (dt) => {
    const { apex, events } = jumpArc(dt);
    expect(apex).toBeGreaterThan(45.5625 - 0.5);
    expect(apex).toBeLessThan(45.5625 + 0.5);
    const jumps = events.filter(([, type]) => type === PMEV_JUMP);
    const lands = events.filter(([, type]) => type === PMEV_LAND);
    expect(jumps.map(([t]) => t)).toEqual([0]);
    expect(lands).toHaveLength(1);
    // Airtime 2 · 270 / 800 = 0.675 s, within a tick; the landing tick ends the flight.
    const airtime = ((lands[0]?.[0] as number) + 1) * dt;
    expect(Math.abs(airtime - 0.675)).toBeLessThanOrEqual(dt + 1e-9);
    // The impact speed is the fall speed at the landing tick's start, about the jump speed.
    expect(lands[0]?.[2]).toBeGreaterThan(250);
    expect(lands[0]?.[2]).toBeLessThanOrEqual(270 + 800 * dt);
  });

  it("gives the same apex at 60 and 120 Hz, within 0.5 u", () => {
    expect(Math.abs(jumpArc(TICK_DT).apex - jumpArc(1 / 120).apex)).toBeLessThanOrEqual(0.5);
  });

  it("emits STEP, JUMP and LAND in tick order", () => {
    const world = worldOf(floorBrush(), box([64, -128, 0], [512, 128, 16]));
    const ps = player(0, 0);
    // Run onto the 16 u step, then jump on it.
    const { events } = run(
      ps,
      world,
      (t) => cmd({ forward: 127, buttons: t === 40 ? BUTTON_JUMP : 0 }),
      100,
    );
    expect(events.map(([, type]) => type)).toEqual([PMEV_STEP, PMEV_JUMP, PMEV_LAND]);
    expect(events[0]?.[2]).toBeCloseTo(16, 9);
    expect(events[1]?.[0]).toBe(40);
  });

  it("emits LAND when a fall reaches the ground, with the fall speed", () => {
    const ps = player(0, 0);
    ps.origin[2] = restZ(0) + 100;
    ps.flags = 0;
    const { events } = run(ps, flat, () => cmd(), 60);
    const lands = events.filter(([, type]) => type === PMEV_LAND);
    expect(lands).toHaveLength(1);
    // Free fall from 100 u: about √(2 · 800 · 100) = 400 u/s.
    expect(lands[0]?.[2]).toBeGreaterThan(380);
    expect(lands[0]?.[2]).toBeLessThan(420);
  });

  it("simulates the same with or without the events ring and the trace log", () => {
    const world = worldOf(
      floorBrush(),
      box([64, -128, 0], [512, 128, 18]),
      box([-300, -64, 0], [-200, 64, 300]),
    );
    const a = player(0, 0);
    const b = new PlayerState();
    copyPlayerState(b, a);
    const log = new PmoveTraceLog();
    const p = new PmoveParams();
    for (let t = 0; t < 400; t++) {
      const c = new UserCmd();
      c.forward = t % 150 < 100 ? 127 : -127;
      c.right = t % 70 < 35 ? 60 : -60;
      c.buttons = t % 45 === 0 ? BUTTON_JUMP : 0;
      c.yaw = degreesToU16((t * 3) % 360);
      run(a, world, () => c, 1, { log });
      pmove(b, c, world, p, TICK_DT, null, null);
      expect(playerStateEquals(a, b), `tick ${t}`).toBe(true);
    }
    expect(log.total).toBeGreaterThan(400 * 2);
    // The log holds real traces: the last one is the post ground probe, pm_groundTraceDist long.
    const r = new PmoveTraceRecord();
    expect(log.read(log.count - 1, r)).toBe(true);
    expect(r.start[2] - r.end[2]).toBe(p.groundTraceDist);
  });
});
