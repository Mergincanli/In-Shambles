import { describe, expect, it } from "vitest";
import { replayTable, vectorTable } from "./helpers/vectorReplay";
import {
  DEGREES_TO_U16_VECTORS,
  DTRIG_VECTORS,
  HASH32_VECTORS,
  MULBERRY32_DRAW_VECTORS,
  MULBERRY32_VECTORS,
  PLAYER_STATE_QUANT_VECTORS,
  QUANT_ORIGIN_VECTORS,
  QUANT_STAMINA_VECTORS,
  QUANT_VELOCITY_VECTORS,
  U16_TRIG_DIGEST_VECTORS,
  U16_TRIG_VECTORS,
  USERCMD_SANITIZE_VECTORS,
} from "./vectors/determinism";

// Risk 2 of the M1 plan: the committed vectors pin the exact bits of the D-016 math. This test
// recomputes them here; `pnpm test:browser` replays the same file in Chrome, Firefox and Safari's
// engine, and the phone vectors page runs the same replays (helpers/vectorReplay.ts).

/** Rows whose recomputed fields differ, as "row → recomputed", so a failure shows every case. */
const mismatches = (name: string) => replayTable(vectorTable(name)).mismatches;

describe("determinism vectors (D-016)", () => {
  it.each([
    ["DTRIG_VECTORS", DTRIG_VECTORS, 150],
    ["U16_TRIG_VECTORS", U16_TRIG_VECTORS, 256],
    ["U16_TRIG_DIGEST_VECTORS", U16_TRIG_DIGEST_VECTORS, 4],
    ["QUANT_ORIGIN_VECTORS", QUANT_ORIGIN_VECTORS, 30],
    ["QUANT_VELOCITY_VECTORS", QUANT_VELOCITY_VECTORS, 30],
    ["QUANT_STAMINA_VECTORS", QUANT_STAMINA_VECTORS, 8],
    ["DEGREES_TO_U16_VECTORS", DEGREES_TO_U16_VECTORS, 8],
    ["MULBERRY32_VECTORS", MULBERRY32_VECTORS, 64],
    ["MULBERRY32_DRAW_VECTORS", MULBERRY32_DRAW_VECTORS, 32],
    ["HASH32_VECTORS", HASH32_VECTORS, 16],
    ["PLAYER_STATE_QUANT_VECTORS", PLAYER_STATE_QUANT_VECTORS, 20],
    ["USERCMD_SANITIZE_VECTORS", USERCMD_SANITIZE_VECTORS, 20],
  ])("%s has its rows", (_name, rows, min) => {
    expect(rows.length).toBeGreaterThanOrEqual(min);
  });

  it("dsin and dcos", () => {
    expect(mismatches("DTRIG_VECTORS")).toEqual([]);
  });

  it("sinU16 and cosU16", () => {
    expect(mismatches("U16_TRIG_VECTORS")).toEqual([]);
  });

  it("sinU16 and cosU16 over all 65536 angles, by digest", () => {
    // Each row digests the angles first..last; together they cover the whole turn once.
    let covered = 0;
    let next = 0;
    for (const row of U16_TRIG_DIGEST_VECTORS) {
      const [first, last] = row.split(" ").map(Number);
      expect(first).toBe(next);
      covered += (last as number) - (first as number) + 1;
      next = (last as number) + 1;
    }
    expect(covered).toBe(65536);
    expect(mismatches("U16_TRIG_DIGEST_VECTORS")).toEqual([]);
  });

  it("quantizers", () => {
    expect(mismatches("QUANT_ORIGIN_VECTORS")).toEqual([]);
    expect(mismatches("QUANT_VELOCITY_VECTORS")).toEqual([]);
    expect(mismatches("QUANT_STAMINA_VECTORS")).toEqual([]);
    expect(mismatches("DEGREES_TO_U16_VECTORS")).toEqual([]);
  });

  it("Mulberry32", () => {
    expect(mismatches("MULBERRY32_VECTORS")).toEqual([]);
  });

  it("Mulberry32 nextFloat and nextInt", () => {
    expect(mismatches("MULBERRY32_DRAW_VECTORS")).toEqual([]);
  });

  it("hash32", () => {
    expect(mismatches("HASH32_VECTORS")).toEqual([]);
  });

  it("quantizePlayerState (prod path: DEV_ASSERT off)", () => {
    expect(vectorTable("PLAYER_STATE_QUANT_VECTORS").prodPath).toBe(true);
    expect(mismatches("PLAYER_STATE_QUANT_VECTORS")).toEqual([]);
  });

  it("sanitizeUserCmd", () => {
    expect(mismatches("USERCMD_SANITIZE_VECTORS")).toEqual([]);
  });
});
