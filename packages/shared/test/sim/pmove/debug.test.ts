import { describe, expect, it } from "vitest";
import { vec3 } from "../../../src/math/vec3";
import {
  PMOVE_TRACE_LOG_CAPACITY,
  PmoveTraceLog,
  PmoveTraceRecord,
} from "../../../src/sim/pmove/debug";
import { TraceResult } from "../../../src/world/trace";

function result(fraction: number, startSolid = false, allSolid = false): TraceResult {
  const tr = new TraceResult();
  tr.fraction = fraction;
  tr.endpos.set([fraction, 2 * fraction, 3 * fraction]);
  tr.normal.set([0, 0, 1]);
  tr.startSolid = startSolid;
  tr.allSolid = allSolid;
  return tr;
}

describe("PmoveTraceLog", () => {
  it("copies a record out field for field", () => {
    const log = new PmoveTraceLog();
    log.record(
      vec3(1, 2, 3),
      vec3(4, 5, 6),
      vec3(-15, -15, -24),
      vec3(15, 15, 16),
      result(0.25, true),
    );
    const r = new PmoveTraceRecord();
    expect(log.read(0, r)).toBe(true);
    expect([...r.start, ...r.end]).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...r.mins, ...r.maxs]).toEqual([-15, -15, -24, 15, 15, 16]);
    expect([...r.endpos]).toEqual([0.25, 0.5, 0.75]);
    expect([...r.normal]).toEqual([0, 0, 1]);
    expect(r.fraction).toBe(0.25);
    expect([r.startSolid, r.allSolid]).toEqual([true, false]);
  });

  it("keeps the newest 64 records, oldest first, and counts every one", () => {
    const log = new PmoveTraceLog();
    const v = vec3();
    for (let i = 0; i < PMOVE_TRACE_LOG_CAPACITY + 10; i++) {
      log.record(vec3(i, 0, 0), v, v, v, result(i / 100));
    }
    expect(log.count).toBe(PMOVE_TRACE_LOG_CAPACITY);
    expect(log.total).toBe(PMOVE_TRACE_LOG_CAPACITY + 10);
    const r = new PmoveTraceRecord();
    log.read(0, r);
    expect(r.start[0]).toBe(10);
    log.read(PMOVE_TRACE_LOG_CAPACITY - 1, r);
    expect(r.start[0]).toBe(PMOVE_TRACE_LOG_CAPACITY + 9);
  });

  it("rejects indexes outside the log and empties on clear", () => {
    const log = new PmoveTraceLog();
    const v = vec3();
    log.record(v, v, v, v, result(1, false, true));
    const r = new PmoveTraceRecord();
    for (const i of [-1, 1, 0.5, Number.NaN]) expect(log.read(i, r), `${i}`).toBe(false);
    expect(r.fraction).toBe(1);
    expect(log.read(0, r)).toBe(true);
    expect(r.allSolid).toBe(true);
    log.clear();
    expect([log.count, log.total]).toEqual([0, 0]);
    expect(log.read(0, r)).toBe(false);
  });
});
