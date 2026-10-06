import { describe, expect, it } from "vitest";
import { replayTable, vectorTable } from "./helpers/vectorReplay";
import { POINT_CONTENTS_VECTORS, SNAP_VECTORS, TRACE_VECTORS, TRACE_WORLD } from "./vectors/trace";

// The committed trace vectors (D-016, D-017): the world is rebuilt from its frozen plane bits,
// not from the polygonizer, so a replay in any engine checks only the trace code. The replays
// live in helpers/vectorReplay.ts, shared with the phone vectors page.

/** Rows whose recomputed fields differ, as "row → recomputed". */
const mismatches = (name: string) => replayTable(vectorTable(name)).mismatches;

describe("trace vectors (D-017)", () => {
  it("have their rows", () => {
    expect(TRACE_WORLD.length).toBeGreaterThanOrEqual(8);
    expect(TRACE_VECTORS.length).toBeGreaterThanOrEqual(150);
    expect(SNAP_VECTORS.length).toBeGreaterThanOrEqual(20);
    expect(SNAP_VECTORS.some((row) => row.split(" ")[13] === "1")).toBe(true);
    expect(POINT_CONTENTS_VECTORS.length).toBeGreaterThanOrEqual(30);
  });

  it.each([["traceBox"], ["traceBoxBrute"]])("%s", (name) => {
    expect(mismatches(`TRACE_VECTORS (${name})`)).toEqual([]);
  });

  it("snapOrigin", () => {
    expect(mismatches("SNAP_VECTORS")).toEqual([]);
  });

  it("pointContents", () => {
    expect(mismatches("POINT_CONTENTS_VECTORS")).toEqual([]);
  });
});
