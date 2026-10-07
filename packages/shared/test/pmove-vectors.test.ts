import { describe, expect, it } from "vitest";
import { PMEV_JUMP, PMEV_LAND, PMEV_STEP } from "../src/sim/events";
import {
  PlayerState,
  PMF_CROUCHED,
  PMF_GROUNDED,
  PMF_ON_LADDER,
  quantizePlayerState,
} from "../src/sim/playerState";
import { PMOVE_CVARS, PmoveParams } from "../src/sim/pmove/params";
import { TICK_DT } from "../src/time";
import { SNAP_CORNER } from "../src/world/trace";
import { hexToF64 } from "./helpers/f64";
import {
  PMOVE_ROW,
  pmoveVectorParams as params,
  pmoveStateFields,
  readPmoveState,
  replayTable,
  vectorTable,
  pmoveVectorWorld as world,
} from "./helpers/vectorReplay";
import { PMOVE_PARAMS, PMOVE_VECTORS, PMOVE_WORLD } from "./vectors/pmove";

// The committed pmove vectors (M2 plan, increment 6; D-016, D-017, D-023, D-024): single ticks
// on a fixed world rebuilt from its plane bits, with the parameters rebuilt from theirs, so a
// replay checks only pmove and what it calls. `pnpm test:browser` replays this file in Chromium,
// Firefox and WebKit (D-022), the browser leg of MV-19; the replays live in
// helpers/vectorReplay.ts, shared with the phone vectors page.
const f64 = (hex: string | undefined) => hexToF64(hex ?? "");
const int = (s: string | undefined) => Number(s ?? "");

const { STATE_IN, STATE_OUT, SNAP, EVENTS } = PMOVE_ROW;
const ps = new PlayerState();

/** Rows whose fields pass `test`, for the coverage checks. */
function count(test: (f: string[]) => boolean): number {
  return PMOVE_VECTORS.filter((row) => test(row.split(" "))).length;
}

const inFlags = (f: string[]) => int(f[STATE_IN + 8]);
const outFlags = (f: string[]) => int(f[STATE_OUT + 8]);
const outWater = (f: string[]) => int(f[STATE_OUT + 10]);
const inMoving = (f: string[]) => f64(f[STATE_IN + 3]) !== 0 || f64(f[STATE_IN + 4]) !== 0;
const hasEvent = (f: string[], type: number) => {
  for (let k = 0; k < int(f[EVENTS]); k++) if (int(f[EVENTS + 1 + 2 * k]) === type) return true;
  return false;
};

describe("pmove vectors (M2 increment 6)", () => {
  it("rebuild their world and both parameter sets", () => {
    expect(world.brushCount).toBe(PMOVE_WORLD.length);
    expect(params).toHaveLength(2);
    // Set 0 is the defaults, every field present; set 1 differs in some.
    const defaults = new PmoveParams();
    for (const row of PMOVE_CVARS) expect(params[0]?.[row.field]).toBe(defaults[row.field]);
    expect(PMOVE_PARAMS[0]?.split(" ")).toHaveLength(2 * PMOVE_CVARS.length);
    expect(PMOVE_PARAMS[1]).not.toBe(PMOVE_PARAMS[0]);
  });

  // SNAP_PREVIOUS (the start-origin fallback) is not reachable from ordinary pmove input
  // (pmoveProperty.test.ts); snapOrigin.test.ts covers it.
  it("cover every movement mode, event, the corner snap, all tick lengths and both sets", () => {
    expect(PMOVE_VECTORS.length).toBeGreaterThanOrEqual(300);
    expect(count((f) => (outFlags(f) & PMF_GROUNDED) !== 0)).toBeGreaterThanOrEqual(100);
    expect(count((f) => (outFlags(f) & PMF_GROUNDED) === 0)).toBeGreaterThanOrEqual(100);
    expect(count((f) => (outFlags(f) & PMF_CROUCHED) !== 0)).toBeGreaterThanOrEqual(20);
    expect(count((f) => (outFlags(f) & PMF_ON_LADDER) !== 0)).toBeGreaterThanOrEqual(20);
    for (const level of [1, 2, 3]) {
      expect(count((f) => outWater(f) === level)).toBeGreaterThan(0);
    }
    expect(count((f) => (outFlags(f) & PMF_CROUCHED) !== 0 && outWater(f) === 3)).toBeGreaterThan(
      0,
    );
    for (const type of [PMEV_STEP, PMEV_JUMP, PMEV_LAND]) {
      expect(count((f) => hasEvent(f, type))).toBeGreaterThan(0);
    }
    expect(count((f) => int(f[SNAP]) === SNAP_CORNER)).toBeGreaterThan(0);
    // Each tick length with horizontal motion, so dt reaches acceleration and friction, on
    // ground and in water.
    for (const dt of [1 / 120, TICK_DT, 1 / 30]) {
      expect(count((f) => f64(f[1]) === dt && inMoving(f))).toBeGreaterThan(0);
      expect(count((f) => f64(f[1]) === dt && inMoving(f) && outWater(f) > 0)).toBeGreaterThan(0);
    }
    // The tuned set where its swim, sink and ladder values apply.
    const tuned = (f: string[]) => f[0] === "1";
    expect(count((f) => tuned(f) && outWater(f) >= 2)).toBeGreaterThan(0);
    expect(count((f) => tuned(f) && (outFlags(f) & PMF_ON_LADDER) !== 0)).toBeGreaterThan(0);
    // A jump while airborne is a ladder push-off; in set 1, with jump held (pm_autoHop).
    expect(
      count((f) => tuned(f) && hasEvent(f, PMEV_JUMP) && (inFlags(f) & PMF_GROUNDED) === 0),
    ).toBeGreaterThan(0);
  });

  it("start from quantized states", () => {
    const again = new PlayerState();
    for (const row of PMOVE_VECTORS) {
      readPmoveState(row.split(" "), STATE_IN, ps);
      quantizePlayerState(readPmoveState(row.split(" "), STATE_IN, again));
      expect(pmoveStateFields(again)).toEqual(pmoveStateFields(ps));
    }
  });

  it("replay bit for bit, one tick at a time", () => {
    expect(replayTable(vectorTable("PMOVE_VECTORS (events)")).mismatches).toEqual([]);
  });

  it("replay the same with the events off and the trace log on (both observers only)", () => {
    const table = vectorTable("PMOVE_VECTORS (trace log on, events off)");
    expect(replayTable(table).mismatches).toEqual([]);
  });
});
