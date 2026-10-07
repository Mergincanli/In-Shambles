import { describe, expect, it } from "vitest";
import {
  replayTable,
  VECTOR_INPUT_TABLES,
  VECTOR_TABLES,
  type VectorTable,
  vectorTable,
} from "./helpers/vectorReplay";
import * as determinism from "./vectors/determinism";
import * as pmove from "./vectors/pmove";
import * as trace from "./vectors/trace";

// The replay list behind the vector tests and the phone vectors page (M2 plan, increment 12):
// every committed table is in it, and a row that drifts is reported, not passed. That `files`
// names every module in test/vectors is checked from Node by
// packages/tools/test/guards/browser-vectors.test.ts.
const files = { determinism, trace, pmove } as const;

describe("vector replay list", () => {
  it("recomputes every table's outputs: a changed output field fails, showing the real row", () => {
    // Some variants carry fields through (PMOVE events off), so look for one output field from
    // the end. A replay that returned its input would find none.
    for (const table of VECTOR_TABLES) {
      const first = table.rows[0] as string;
      const fields = first.split(" ");
      let found = -1;
      for (let i = fields.length - 1; i >= 0 && found < 0; i--) {
        const f = fields.slice();
        f[i] = `${f[i]}x`;
        const broken = f.join(" ");
        let r: ReturnType<typeof replayTable> | null = null;
        try {
          r = replayTable({ ...table, rows: [broken] });
        } catch {
          // An input field that no longer parses.
        }
        if (r !== null && r.failed === 1 && r.mismatches[0] === `${broken} → ${first}`) found = i;
      }
      expect([table.name, found >= 0]).toEqual([table.name, true]);
    }
  });

  it("replays every table exported by test/vectors/*.ts, from its own file", () => {
    for (const [file, exports] of Object.entries(files)) {
      for (const name of Object.keys(exports)) {
        if ((VECTOR_INPUT_TABLES as readonly string[]).includes(name)) continue;
        const tables = VECTOR_TABLES.filter((t) => t.name.split(" ")[0] === name);
        expect(tables.length, name).toBeGreaterThan(0);
        for (const t of tables) {
          expect(t.file).toBe(file);
          expect(t.rows).toBe((exports as Record<string, unknown>)[name]);
        }
      }
    }
    expect(new Set(VECTOR_TABLES.map((t) => t.name)).size).toBe(VECTOR_TABLES.length);
  });

  it("counts a changed row as failed, with the recomputed row", () => {
    const real = vectorTable("HASH32_VECTORS");
    const first = real.rows[0] as string;
    const broken: VectorTable = {
      ...real,
      rows: [`${first.slice(0, -1)}x`, ...real.rows.slice(1)],
    };
    const r = replayTable(broken);
    expect(r.failed).toBe(1);
    expect(r.passed).toBe(real.rows.length - 1);
    expect(r.mismatches[0]).toBe(`${first.slice(0, -1)}x → ${first}`);
  });

  it("throws for an unknown table name", () => {
    expect(() => vectorTable("NOPE_VECTORS")).toThrow(/no vector table/);
  });
});
