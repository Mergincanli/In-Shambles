import { PMEV_JUMP, PMEV_LAND, PMEV_STEP, SNAP_PREVIOUS } from "@game/shared";
import type { ScenarioRecord } from "./runner";

/**
 * Measurements over a ScenarioRecord (M2 design §5): speed curves, apex, time to a cap and the
 * event lists the MV tests and the feel report compare with their targets. They run after the
 * tick loop, so they may allocate.
 */

export function horizontalSpeed(r: ScenarioRecord, i: number): number {
  const vx = r.velocity[3 * i] as number;
  const vy = r.velocity[3 * i + 1] as number;
  return Math.sqrt(vx * vx + vy * vy);
}

/** Horizontal speed at every recorded state. */
export function speedCurve(r: ScenarioRecord): Float64Array {
  const out = new Float64Array(r.count);
  for (let i = 0; i < r.count; i++) out[i] = horizontalSpeed(r, i);
  return out;
}

/** The highest horizontal speed over states [from, to). */
export function maxHorizontalSpeed(r: ScenarioRecord, from = 0, to = r.count): number {
  let max = 0;
  for (let i = from; i < Math.min(to, r.count); i++) max = Math.max(max, horizontalSpeed(r, i));
  return max;
}

/**
 * The first state from which every later recorded state's horizontal speed stays within
 * `target ± tolerance`, or −1 if the run never settles there. Time to the cap = index · dt.
 */
export function settledIndex(r: ScenarioRecord, target: number, tolerance: number): number {
  let first = -1;
  for (let i = 0; i < r.count; i++) {
    const inside = Math.abs(horizontalSpeed(r, i) - target) <= tolerance;
    if (!inside) first = -1;
    else if (first < 0) first = i;
  }
  return first;
}

/** Ticks whose end-of-tick snap fell back to the start origin (SNAP_PREVIOUS, D-017). */
export function snapFallbacks(r: ScenarioRecord): number {
  let n = 0;
  for (let i = 1; i < r.count; i++) if (r.snap[i] === SNAP_PREVIOUS) n++;
  return n;
}

/** Ticks that ended airborne, over states [from, to). */
export function airborneTicks(r: ScenarioRecord, from = 1, to = r.count): number {
  let n = 0;
  for (let i = from; i < Math.min(to, r.count); i++) if (!r.grounded(i)) n++;
  return n;
}

export interface Apex {
  /** State index of the highest origin z (the first, if several tie). */
  readonly index: number;
  /** Height above state 0. */
  readonly height: number;
}

export function apex(r: ScenarioRecord): Apex {
  let index = 0;
  for (let i = 1; i < r.count; i++) if (r.z(i) > r.z(index)) index = i;
  return { index, height: r.z(index) - r.z(0) };
}

export interface RecordedEvent {
  /** The tick that emitted it (1-based, so state `tick` is the state after it). */
  readonly tick: number;
  readonly value: number;
}

/** Events of one PMEV_* type, in order. */
export function eventsOf(r: ScenarioRecord, type: number): RecordedEvent[] {
  const out: RecordedEvent[] = [];
  for (let e = 0; e < r.eventCount; e++) {
    if (r.eventType[e] === type) {
      out.push({ tick: r.eventTick[e] as number, value: r.eventValue[e] as number });
    }
  }
  return out;
}

export const steps = (r: ScenarioRecord): RecordedEvent[] => eventsOf(r, PMEV_STEP);
export const jumps = (r: ScenarioRecord): RecordedEvent[] => eventsOf(r, PMEV_JUMP);
export const lands = (r: ScenarioRecord): RecordedEvent[] => eventsOf(r, PMEV_LAND);

/** Horizontal speed right after each landing: the strafe-gain curve (MV-08). */
export function landingSpeeds(r: ScenarioRecord): number[] {
  return lands(r).map((e) => horizontalSpeed(r, e.tick));
}

/**
 * Airtime of a jump in seconds: from the tick that jumped to the tick that landed, both
 * airborne moves, so (land − jump + 1) · dt.
 */
export function airtime(r: ScenarioRecord, jump: RecordedEvent, land: RecordedEvent): number {
  return (land.tick - jump.tick + 1) * r.dt;
}

/**
 * The line each MV test logs (docs/03 §8: every test logs measured vs. target), e.g.
 * `MV-01 run cap: measured 320.00 u/s, target 320 ± 0.5 u/s`.
 */
export function measuredLine(id: string, what: string, measured: string, target: string): string {
  return `${id} ${what}: measured ${measured}, target ${target}`;
}

export function logMeasured(id: string, what: string, measured: string, target: string): void {
  console.log(measuredLine(id, what, measured, target));
}
