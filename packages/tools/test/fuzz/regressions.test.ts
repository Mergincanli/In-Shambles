import { positionTest, TRACE_EPSILON, TraceResult, traceBox, vec3 } from "@game/shared";
import { describe, expect, it } from "vitest";
import { CaseSampler } from "./cases";
import { type OracleBrush, separation } from "./oracle";
import {
  checkCase,
  type FuzzRegression,
  f64Hex,
  formatFailure,
  regressionCase,
  runtimeInside,
  TAU,
  traceDigest,
} from "./properties";
import { COURSE_NAMES, loadFuzzWorld, syntheticWorldNames } from "./worlds";

// Fuzz cases kept for good: paste a failure the fuzz test prints into REGRESSIONS, fix the bug,
// and the case stays checked by every property whatever the sampler draws later. The fuzz runs
// so far (20k default, 1M and 10M local) found no trace, BVH or snap bug, so the list holds the
// tightest boundary cases they drew instead, pinning behaviour at exactly the margins the
// properties test. Seed and case index record where a case came from; a later sampler change
// draws other cases at those indices.

const REGRESSIONS: readonly FuzzRegression[] = [
  {
    // P1 at 0: a standing hull whose sweep ends exactly touching a jump_lab brush.
    property: "P1",
    seed: 0x5eed0009,
    caseIndex: 293,
    world: "jump_lab",
    hull: "standing",
    start: ["c077100000000000", "c098000000000000", "4042000000000000"], // -369, -1536, 36
    end: ["c0770af35bdad7ca", "c092f095e832c0e2", "c046397907699492"], // -368.6844137714912, -1212.146393578551, -44.449006010582835
    mins: ["c02e000000000000", "c02e000000000000", "c038000000000000"], // -15, -15, -24
    maxs: ["402e000000000000", "402e000000000000", "4040000000000000"], // 15, 15, 32
    mask: 3,
  },
  {
    // P4's widest stop: ε plus the bevel slop of a brush 8000 u out, where f32 steps are 2^-10.
    property: "P4",
    seed: 0x5eed0009,
    caseIndex: 4265,
    world: "synthetic:0x7d241d59",
    hull: "standing",
    start: ["c0c0bd2800000000", "c0b4961800000000", "40a8fc9000000000"], // -8570.3125, -5270.09375, 3198.28125
    end: ["c0c3fe72b3e60a5f", "c0b6c30c6937b214", "40a8fc9000000000"], // -10236.89611506945, -5827.048480492569, 3198.28125
    mins: ["c02e000000000000", "c02e000000000000", "c038000000000000"], // -15, -15, -24
    maxs: ["402e000000000000", "402e000000000000", "4040000000000000"], // 15, 15, 32
    mask: 3,
  },
  {
    // P2 at 0: a ray starting on a rotated box's vertical edge, inside by 1e-12 of rounding.
    property: "P2",
    seed: 0x5eed0009,
    caseIndex: 1355,
    world: "synthetic:0x82b45d33",
    hull: "ray",
    start: ["4051e7e247713600", "403801bd96d4b000", "4051c10000000000"], // 71.62318597846752, 24.006799151349696, 71.015625
    end: ["405136a42d8cba54", "403732017c8cf158", "4051d38d4c198f27"], // 68.85377062552408, 23.195335182580806, 71.30549910064711
    mins: ["0000000000000000", "0000000000000000", "0000000000000000"], // 0, 0, 0
    maxs: ["0000000000000000", "0000000000000000", "0000000000000000"], // 0, 0, 0
    mask: 3,
  },
  {
    // P2 in the bevel sliver: runtime inside brush 2, 1.1e-4 u outside its vertices (see below).
    property: "P2",
    seed: 0x5eed0009,
    caseIndex: 2516,
    world: "synthetic:0xfdac2e2c",
    hull: "standing",
    start: ["40b344b82740ed6c", "c0b8ab9800000000", "409ff75b80000000"], // 4932.71934896275, -6315.59375, 2045.83935546875
    end: ["40b344b82e81dae0", "c0b97d0000000000", "409f875b80000000"], // 4932.719459644257, -6525, 2017.83935546875
    mins: ["c02e000000000000", "c02e000000000000", "c038000000000000"], // -15, -15, -24
    maxs: ["402e000000000000", "402e000000000000", "4040000000000000"], // 15, 15, 32
    mask: 3,
  },
  {
    // P4 above ε: a ray stopped under a wedge's floor, where the oracle's reversed slope normal
    // reads 1.10·ε although every expanded plane is within ε (why P4 keeps 2√3·ε).
    property: "P4",
    seed: 0x5eed0009,
    caseIndex: 428381,
    world: "synthetic:0x9b798a00",
    hull: "ray",
    start: ["4068630000000000", "c05b2e0000000000", "c037080000000000"], // 195.09375, -108.71875, -23.03125
    end: ["4068e7f7b247c8e7", "c059932e3864bc3b", "c03707d1e6866968"], // 199.24898637791122, -102.29969606244497, -23.030546577277534
    mins: ["0000000000000000", "0000000000000000", "0000000000000000"], // 0, 0, 0
    maxs: ["0000000000000000", "0000000000000000", "0000000000000000"], // 0, 0, 0
    mask: 3,
  },
];

describe("trace fuzz regressions", () => {
  it.each(REGRESSIONS.map((r) => [`${r.property} ${r.world} case ${r.caseIndex}`, r] as const))(
    "%s",
    (_name, r) => {
      const res = checkCase(loadFuzzWorld(r.world), regressionCase(r));
      expect(res.failures).toEqual([]);
    },
  );

  it("P2 needs the bevel slop: the runtime brush reaches past its vertices by an f32 step", () => {
    // Bevels round outward to an f32 (D-019), so the box-expanded test calls this start solid
    // although the oracle puts it 1.1e-4 u clear. With τ alone P2 would fail here.
    const r = REGRESSIONS[3] as FuzzRegression;
    const c = regressionCase(r);
    const fw = loadFuzzWorld(r.world);
    const b = fw.brushes[2] as OracleBrush;
    expect(runtimeInside(fw.world, 2, c.start, c.mins, c.maxs)).toBe(true);
    const sep = separation(b, c.start, c.start, c.mins, c.maxs);
    expect(sep).toBeGreaterThan(TAU);
    expect(sep).toBeLessThan(TAU + b.slop);
  });

  it("P1 excuses a sliver start, which may pass through that brush but is never reached", () => {
    // The runtime puts this start inside brush 2, so by A.4 the box may move out through it: a
    // 600 u sweep crosses the whole brush. The oracle has the start 1.1e-4 u clear, so this is
    // the one place P1 does not see; it is safe because positionTest rejects the start, so
    // snapOrigin never produces it and no trace stops there (traces stop ε short of bevels).
    const r = REGRESSIONS[3] as FuzzRegression;
    const c = regressionCase(r);
    const fw = loadFuzzWorld(r.world);
    const b = fw.brushes[2] as OracleBrush;
    const end = vec3(c.start[0] + 600, c.start[1], c.start[2]);
    const out = new TraceResult();
    traceBox(fw.world, c.start, end, c.mins, c.maxs, c.mask, out);
    expect(out.startSolid).toBe(true);
    expect(out.fraction).toBe(1);
    expect(separation(b, c.start, c.start, c.mins, c.maxs)).toBeGreaterThan(TAU);
    expect(separation(b, c.start, out.endpos, c.mins, c.maxs)).toBeLessThan(-1);
    expect(positionTest(fw.world, c.start, c.mins, c.maxs, c.mask)).toBe(false);
    const res = checkCase(fw, { ...c, end });
    expect(res.failures).toEqual([]);
    expect(res.sliverStart).toBe(true);
  });

  it("P4 needs more than ε: the oracle measures a wedge's slope normal on both sides", () => {
    const r = REGRESSIONS[4] as FuzzRegression;
    const c = regressionCase(r);
    const fw = loadFuzzWorld(r.world);
    const out = new TraceResult();
    traceBox(fw.world, c.start, c.end, c.mins, c.maxs, c.mask, out);
    expect(out.brush).toBe(9);
    const b = fw.brushes[9] as OracleBrush;
    const sep = separation(b, out.endpos, out.endpos, c.mins, c.maxs);
    expect(sep).toBeGreaterThan(TRACE_EPSILON + TAU + b.slop);
    expect(sep).toBeLessThan(Math.SQRT2 * TRACE_EPSILON);
  });

  it("a printed failure pastes back as the same case", () => {
    const courses = COURSE_NAMES.map(loadFuzzWorld);
    const sampler = new CaseSampler(7, courses, syntheticWorldNames(7, 4).map(loadFuzzWorld));
    const a = new TraceResult();
    const b = new TraceResult();
    for (let i = 0; i < 50; i++) {
      const c = sampler.next();
      const text = formatFailure("P1", "round trip", 7, i, c).replace(/,\s*$/, "");
      const parsed = new Function(`return (${text});`)() as FuzzRegression;
      const back = regressionCase(parsed);
      expect(back.world).toBe(c.world);
      expect(back.mask).toBe(c.mask);
      for (const key of ["start", "end", "mins", "maxs"] as const) {
        expect([...back[key]].map(f64Hex)).toEqual([...c[key]].map(f64Hex));
      }
      const fw = loadFuzzWorld(c.world);
      traceBox(fw.world, c.start, c.end, c.mins, c.maxs, c.mask, a);
      traceBox(fw.world, back.start, back.end, back.mins, back.maxs, back.mask, b);
      expect(traceDigest(b)).toBe(traceDigest(a));
    }
  });
});
