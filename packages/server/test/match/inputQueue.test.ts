import { UserCmd } from "@game/shared";
import { describe, expect, it } from "vitest";
import { INPUT_QUEUE_HORIZON, InputQueue } from "../../src/match/inputQueue";

function cmdAt(tick: number, forward = 0): UserCmd {
  const c = new UserCmd();
  c.tick = tick;
  c.forward = forward;
  return c;
}

function counters(q: InputQueue) {
  return { accepted: q.accepted, duplicates: q.duplicates, late: q.late, early: q.early };
}

describe("InputQueue", () => {
  it("stores cmds by tick in any order and hands each out once", () => {
    const q = new InputQueue();
    q.reset(10);
    expect(q.push(cmdAt(12, 3))).toBe(true);
    expect(q.push(cmdAt(10, 1))).toBe(true);
    expect(q.push(cmdAt(11, 2))).toBe(true);
    expect(q.newestTick).toBe(12);
    const out = new UserCmd();
    for (const [tick, forward] of [
      [10, 1],
      [11, 2],
      [12, 3],
    ] as const) {
      expect(q.take(tick, out)).toBe(true);
      expect(out.tick).toBe(tick);
      expect(out.forward).toBe(forward);
    }
    expect(q.take(13, out)).toBe(false);
    expect(out.tick).toBe(12);
    expect(counters(q)).toEqual({ accepted: 3, duplicates: 0, late: 0, early: 0 });
  });

  it("copies on push, so the caller's cmd is free again", () => {
    const q = new InputQueue();
    q.reset(0);
    const c = cmdAt(0, 7);
    q.push(c);
    c.forward = -7;
    const out = new UserCmd();
    q.take(0, out);
    expect(out.forward).toBe(7);
  });

  it("drops and counts duplicates (input redundancy sends each cmd up to four times)", () => {
    const q = new InputQueue();
    q.reset(5);
    expect(q.push(cmdAt(5, 1))).toBe(true);
    expect(q.push(cmdAt(5, 99))).toBe(false);
    expect(q.push(cmdAt(5, 99))).toBe(false);
    const out = new UserCmd();
    q.take(5, out);
    expect(out.forward).toBe(1);
    expect(counters(q)).toEqual({ accepted: 1, duplicates: 2, late: 0, early: 0 });
  });

  it("drops and counts cmds for ticks already taken or skipped", () => {
    const q = new InputQueue();
    q.reset(100);
    expect(q.push(cmdAt(99))).toBe(false);
    const out = new UserCmd();
    expect(q.take(100, out)).toBe(false);
    // A cmd for a tick the match already simulated (starved) is too late now.
    expect(q.push(cmdAt(100))).toBe(false);
    expect(q.next).toBe(101);
    expect(counters(q)).toEqual({ accepted: 0, duplicates: 0, late: 2, early: 0 });
  });

  it("counts copies of cmds already simulated as duplicates, not late", () => {
    // A lossless link with 4× redundancy, cmds two ticks ahead: every cmd arrives four times, the
    // last copies after its tick was simulated. Nothing is late.
    const q = new InputQueue();
    q.reset(10);
    const out = new UserCmd();
    for (let t = 10; t < 110; t++) {
      for (let k = 0; k < 4; k++) if (t + 2 - k >= 10) q.push(cmdAt(t + 2 - k));
      expect(q.take(t, out)).toBe(true);
      expect(out.tick).toBe(t);
    }
    expect(q.late).toBe(0);
    expect(q.accepted).toBe(102);
    expect(q.duplicates).toBe(399 - 102);
    // A cmd for a tick that was simulated without it (starved) is late.
    expect(q.take(112, out)).toBe(false);
    expect(q.push(cmdAt(112))).toBe(false);
    expect(q.late).toBe(1);
    // And a taken cmd is never handed out twice.
    expect(q.take(109, out)).toBe(false);
  });

  it("tracks the newest tick received, late or accepted, capped at the horizon", () => {
    const q = new InputQueue();
    q.reset(100);
    expect(q.newestTick).toBe(99);
    q.take(100, new UserCmd());
    q.take(101, new UserCmd());
    q.take(102, new UserCmd());
    // A client two ticks behind: every cmd is late, but it is what the client sent.
    expect(q.push(cmdAt(101))).toBe(false);
    expect(q.newestTick).toBe(101);
    expect(q.push(cmdAt(100))).toBe(false);
    expect(q.newestTick).toBe(101);
    expect(q.push(cmdAt(0x3fffffff))).toBe(false);
    expect(q.newestTick).toBe(103 + INPUT_QUEUE_HORIZON);
  });

  it("accepts up to the horizon ahead of the next tick and drops anything further", () => {
    const q = new InputQueue();
    q.reset(1000);
    expect(q.push(cmdAt(1000 + INPUT_QUEUE_HORIZON - 1))).toBe(true);
    expect(q.push(cmdAt(1000 + INPUT_QUEUE_HORIZON))).toBe(false);
    expect(q.push(cmdAt(0x3fffffff))).toBe(false);
    // Received, though dropped: counted as the horizon itself.
    expect(q.newestTick).toBe(1000 + INPUT_QUEUE_HORIZON);
    expect(counters(q)).toEqual({ accepted: 1, duplicates: 0, late: 0, early: 2 });
    // The horizon moves with the next tick.
    q.take(1000, new UserCmd());
    expect(q.push(cmdAt(1000 + INPUT_QUEUE_HORIZON))).toBe(true);
  });

  it("never hands out a stale slot for a tick that shares it", () => {
    const q = new InputQueue();
    q.reset(0);
    q.push(cmdAt(3, 1));
    const out = new UserCmd();
    // Ticks 0..66 pass without a take of tick 3 (the match skipped ahead).
    expect(q.take(3 + INPUT_QUEUE_HORIZON, out)).toBe(false);
    expect(q.take(3, out)).toBe(true);
    q.reset(0);
    expect(q.take(3, out)).toBe(false);
  });

  it("reset forgets cmds and counters", () => {
    const q = new InputQueue();
    q.reset(0);
    q.push(cmdAt(1));
    q.push(cmdAt(1));
    q.reset(50);
    // One below the first tick to take: health counts from the spawn tick.
    expect(q.newestTick).toBe(49);
    expect(q.next).toBe(50);
    expect(counters(q)).toEqual({ accepted: 0, duplicates: 0, late: 0, early: 0 });
    expect(q.take(1, new UserCmd())).toBe(false);
  });
});
