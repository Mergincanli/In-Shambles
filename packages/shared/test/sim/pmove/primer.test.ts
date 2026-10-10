import { describe, expect, it } from "vitest";
import { CvarRegistry } from "../../../src/cvars/registry";
import { vec3 } from "../../../src/math/vec3";
import { HULL_MINS, HULL_STANDING_MAXS } from "../../../src/sim/hull";
import { PlayerState } from "../../../src/sim/playerState";
import {
  PMOVE_CVARS,
  PmoveParams,
  refreshPmoveParams,
  registerPmoveCvars,
} from "../../../src/sim/pmove/params";
import { pmove } from "../../../src/sim/pmove/pmove";
import {
  buildPrimerWorld,
  PMOVE_PRIMER_TICKS,
  PRIMER_SCRIPT,
  PrimerTally,
  pmovePrimed,
  primePmove,
} from "../../../src/sim/pmove/primer";
import { BUTTON_JUMP, UserCmd } from "../../../src/sim/usercmd";
import { TICK_DT } from "../../../src/time";
import { MASK_PLAYERSOLID } from "../../../src/world/contents";
import { positionTest, TRACE_EPSILON } from "../../../src/world/trace";

// The pmove primer (D-040, M3 design §2.11): its course, its script, and that it is inert. The
// MV-19 and match digests with and without it are in @game/tools and @game/server; the guards
// that it removes the late-branch transient (no-retry processes, block coverage) are in
// `pnpm test:long` (packages/tools/long/pmove-primer.long.ts).

function tally(params: PmoveParams, ticks: number): PrimerTally {
  const t = new PrimerTally();
  primePmove(params, ticks, t);
  return t;
}

/** Every number field of the params, by name. */
function snapshotParams(p: PmoveParams): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of PMOVE_CVARS) out[row.field] = p[row.field];
  out.version = p.version;
  return out;
}

describe("pmove primer (D-040)", () => {
  it("is built once: the course is cached", () => {
    expect(buildPrimerWorld()).toBe(buildPrimerWorld());
  });

  it("starts every scripted stretch clear of solid, inside the walled area", () => {
    const world = buildPrimerWorld();
    const o = vec3();
    let starts = 0;
    for (const g of PRIMER_SCRIPT) {
      if (g.at === null) continue;
      starts++;
      o[0] = g.at[0];
      o[1] = g.at[1];
      o[2] = g.at[2] - (HULL_MINS[2] as number) + TRACE_EPSILON;
      expect(
        positionTest(world, o, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID),
        `${g.at}`,
      ).toBe(true);
    }
    expect(starts).toBeGreaterThan(30);
    expect(PRIMER_SCRIPT[0]?.at).not.toBeNull();
  });

  it("reaches every move mode and event in PMOVE_PRIMER_TICKS, the same way every run", () => {
    const p = new PmoveParams();
    const a = tally(p, PMOVE_PRIMER_TICKS);
    expect(a.ticks).toBe(PMOVE_PRIMER_TICKS);
    // Each mode has thousands of ticks: V8 optimizes a move function only after some thousands
    // of calls, and the primer's point is that it does so before play.
    expect(a.grounded).toBeGreaterThan(5000);
    expect(a.ladder).toBeGreaterThan(4000);
    expect(a.swimming).toBeGreaterThan(4000);
    expect(a.crouched).toBeGreaterThan(1000);
    expect(a.jumps).toBeGreaterThan(10);
    expect(a.steps).toBeGreaterThan(10);
    expect(a.lands).toBeGreaterThan(30);
    // Each pass of the script under its pairing of events and trace log: none (S ticks), events
    // (S), both (the rest; PMOVE_PRIMER_TICKS is about 2.8 passes, so the log alone is never run).
    let script = 0;
    for (const g of PRIMER_SCRIPT) script += g.ticks;
    expect(2 * script).toBeLessThan(PMOVE_PRIMER_TICKS);
    expect(3 * script).toBeGreaterThan(PMOVE_PRIMER_TICKS);
    expect(a.withEvents).toBe(PMOVE_PRIMER_TICKS - script);
    expect(a.withLog).toBe(PMOVE_PRIMER_TICKS - 2 * script);
    expect(a.traces).toBeGreaterThan(a.withLog);
    // The same counts again, from the scratch state the run above left (a shorter run: the
    // inertness test below checks the ticks themselves).
    expect(tally(p, 2500)).toEqual(tally(p, 2500));
  });

  it("is inert: it writes no params, registry or caller state, and pmove after it simulates the same", () => {
    const reg = new CvarRegistry();
    registerPmoveCvars(reg);
    const p = new PmoveParams();
    refreshPmoveParams(reg, p);
    const before = snapshotParams(p);
    const version = reg.version;

    // A player mid-run, ticked before and after a primer pass, against a twin never primed.
    const world = buildPrimerWorld();
    const run = (prime: boolean): number[] => {
      const ps = new PlayerState();
      ps.origin[0] = -1536;
      ps.origin[1] = -256;
      ps.origin[2] = 24 + TRACE_EPSILON;
      const cmd = new UserCmd();
      const out: number[] = [];
      for (let t = 0; t < 600; t++) {
        if (prime && t === 300) primePmove(p, 2000);
        cmd.forward = 127;
        cmd.right = t % 200 < 100 ? 127 : -127;
        cmd.yaw = (t * 150) & 0xffff;
        cmd.buttons = t % 40 === 0 ? BUTTON_JUMP : 0;
        cmd.pitch = ((t * 53) % 6000) & 0xffff;
        pmove(ps, cmd, world, p, TICK_DT, null, null);
        // Every field of the state, so a leak into any of them shows.
        const o = ps.origin;
        const v = ps.velocity;
        out.push(o[0], o[1], o[2], v[0], v[1], v[2], ps.viewYaw, ps.viewPitch, ps.flags);
        out.push(ps.groundEntity, ps.waterLevel, ps.stamina);
      }
      return out;
    };
    expect(run(true)).toEqual(run(false));
    expect(snapshotParams(p)).toEqual(before);
    expect(reg.version).toBe(version);
    expect(p.registry).toBe(reg);
  });

  it("leaves a module instance unprimed until primePmoveOnce (the match test checks the rest)", () => {
    // Vitest gives each test file its own module instances; primePmove does not count as it.
    expect(pmovePrimed()).toBe(false);
  });
});
