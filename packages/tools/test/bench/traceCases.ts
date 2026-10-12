import {
  HULL_CROUCHED_MAXS,
  HULL_MINS,
  HULL_STANDING_MAXS,
  MASK_PLAYERSOLID,
  MASK_SOLID,
  pointContents,
  positionTest,
  vec3,
} from "@game/shared";
import { expect } from "vitest";
import { type CaseSet, loadMovementLab, type TraceWorkload } from "../../bench/trace.bench";

// The trace bench workload's cases on movement_lab, read back for its tests in both tiers (D-032):
// `trace-bench.test.ts` and `packages/tools/long/trace-bench-workload.long.ts`.

export const world = loadMovementLab();

export function set(w: TraceWorkload, name: string): CaseSet {
  const s = w.sets.find((c) => c.category.name === name);
  if (s === undefined) throw new Error(`no ${name} cases`);
  return s;
}

export function maxsOf(s: CaseSet, i: number) {
  return s.hull[i] === 0 ? HULL_STANDING_MAXS : HULL_CROUCHED_MAXS;
}

export function startOf(s: CaseSet, i: number) {
  return vec3(s.start[3 * i] as number, s.start[3 * i + 1] as number, s.start[3 * i + 2] as number);
}

export function endOf(s: CaseSet, i: number) {
  return vec3(s.end[3 * i] as number, s.end[3 * i + 1] as number, s.end[3 * i + 2] as number);
}

export function startsClear(s: CaseSet, i: number): boolean {
  if (s.category.query === "ray") return (pointContents(world, startOf(s, i)) & MASK_SOLID) === 0;
  return positionTest(world, startOf(s, i), HULL_MINS, maxsOf(s, i), MASK_PLAYERSOLID);
}

/** Every move, ground, step and ray case of `w` starts clear of solid. */
export function expectStartsClear(w: TraceWorkload): void {
  for (const name of ["move", "ground", "step", "ray"]) {
    const s = set(w, name);
    let solid = 0;
    for (let i = 0; i < w.size; i++) if (!startsClear(s, i)) solid++;
    expect(solid, name).toBe(0);
  }
}
