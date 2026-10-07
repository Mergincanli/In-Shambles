import { describe, expect, it } from "vitest";
import {
  PMEV_JUMP,
  PMEV_LAND,
  PMEV_NONE,
  PMEV_STEP,
  PMOVE_EVENTS_CAPACITY,
  PmoveEvent,
  PmoveEvents,
} from "../../src/sim/events";

function contents(ev: PmoveEvents): [number, number][] {
  const out = new PmoveEvent();
  const list: [number, number][] = [];
  for (let i = 0; i < ev.count; i++) {
    ev.read(i, out);
    list.push([out.type, out.value]);
  }
  return list;
}

describe("PmoveEvents (M2 design §2)", () => {
  it("uses distinct non-zero types", () => {
    const types = [PMEV_STEP, PMEV_JUMP, PMEV_LAND];
    expect(new Set(types).size).toBe(3);
    expect(types).not.toContain(PMEV_NONE);
    expect(PMOVE_EVENTS_CAPACITY).toBe(8);
  });

  it("reads events oldest first with their values", () => {
    const ev = new PmoveEvents();
    expect(ev.count).toBe(0);
    ev.push(PMEV_STEP, -17.96875);
    ev.push(PMEV_JUMP, 0);
    ev.push(PMEV_LAND, 412.5);
    expect(ev.count).toBe(3);
    expect(contents(ev)).toEqual([
      [PMEV_STEP, -17.96875],
      [PMEV_JUMP, 0],
      [PMEV_LAND, 412.5],
    ]);
  });

  it("keeps the newest 8, counting what it dropped", () => {
    const ev = new PmoveEvents();
    for (let i = 1; i <= 11; i++) ev.push(PMEV_STEP, i);
    expect(ev.count).toBe(PMOVE_EVENTS_CAPACITY);
    expect(ev.dropped).toBe(3);
    expect(contents(ev).map(([, v]) => v)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("starts over after clear", () => {
    const ev = new PmoveEvents();
    for (let i = 0; i < 10; i++) ev.push(PMEV_LAND, i);
    ev.clear();
    expect(ev.count).toBe(0);
    expect(ev.dropped).toBe(0);
    ev.push(PMEV_JUMP, 0);
    expect(contents(ev)).toEqual([[PMEV_JUMP, 0]]);
  });

  it("reads PMEV_NONE outside [0, count) and for non-integer indices", () => {
    const ev = new PmoveEvents();
    ev.push(PMEV_STEP, 16);
    ev.push(PMEV_STEP, -8);
    const out = new PmoveEvent();
    for (const i of [2, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      // Garbage first, so the read has to reset both fields.
      out.type = PMEV_LAND;
      out.value = 99;
      expect(ev.read(i, out), String(i)).toEqual({ type: PMEV_NONE, value: 0 });
    }
    expect(ev.read(0, out)).toMatchObject({ type: PMEV_STEP, value: 16 });
    expect(ev.read(1, out)).toMatchObject({ type: PMEV_STEP, value: -8 });
  });

  it("wraps around the ring repeatedly", () => {
    const ev = new PmoveEvents();
    const pushed: number[] = [];
    for (let i = 0; i < 29; i++) {
      ev.push(PMEV_STEP, i);
      pushed.push(i);
      expect(contents(ev).map(([, v]) => v)).toEqual(pushed.slice(-PMOVE_EVENTS_CAPACITY));
    }
    expect(ev.dropped).toBe(29 - PMOVE_EVENTS_CAPACITY);
  });
});
