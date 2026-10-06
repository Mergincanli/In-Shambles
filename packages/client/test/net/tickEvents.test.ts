import { describe, expect, it } from "vitest";
import { TICK_EVENTS_CAPACITY, TickEvents } from "../../src/net/clientSim";

describe("TickEvents", () => {
  it("keeps the oldest events in order when full and counts the rest as dropped", () => {
    const ev = new TickEvents();
    const extra = 5;
    for (let i = 0; i < TICK_EVENTS_CAPACITY + extra; i++)
      ev.push(1 + (i % 3), i * 0.5, 100 + i, i % 2 === 1);
    expect(ev.count).toBe(TICK_EVENTS_CAPACITY);
    expect(ev.dropped).toBe(extra);
    for (let i = 0; i < TICK_EVENTS_CAPACITY; i++) {
      expect([ev.types[i], ev.values[i], ev.ticks[i], ev.jumped[i]]).toEqual([
        1 + (i % 3),
        i * 0.5,
        100 + i,
        i % 2,
      ]);
    }
    ev.clear();
    expect([ev.count, ev.dropped]).toEqual([0, 0]);
    ev.push(2, 16, 7, false);
    expect([ev.count, ev.types[0], ev.ticks[0], ev.jumped[0]]).toEqual([1, 2, 7, 0]);
  });
});
