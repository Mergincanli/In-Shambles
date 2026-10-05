import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromRoot } from "../src/paths";
import { DETERMINISM_VECTORS_FILE, renderDeterminismVectors } from "../src/vectors/determinism";
import { renderTraceVectors, TRACE_VECTORS_FILE } from "../src/vectors/trace";

describe.each([
  ["determinism", DETERMINISM_VECTORS_FILE, renderDeterminismVectors],
  ["trace", TRACE_VECTORS_FILE, renderTraceVectors],
] as const)("%s vectors file", (_name, file, render) => {
  it("matches its generator (run `pnpm --filter @game/tools vectors` and commit)", () => {
    const committed = readFileSync(fromRoot(...file), "utf8");
    expect(render() === committed).toBe(true);
  });

  it("is plain data: no imports, so browsers can load it as is", () => {
    const committed = readFileSync(fromRoot(...file), "utf8");
    expect(committed).not.toMatch(/^\s*import\b|\brequire\(/m);
  });
});
