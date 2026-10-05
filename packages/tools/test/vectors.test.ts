import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromRoot } from "../src/paths";
import { DETERMINISM_VECTORS_FILE, renderDeterminismVectors } from "../src/vectors/determinism";

describe("determinism vectors file", () => {
  it("matches its generator (run `pnpm --filter @game/tools vectors` and commit)", () => {
    const committed = readFileSync(fromRoot(...DETERMINISM_VECTORS_FILE), "utf8");
    expect(renderDeterminismVectors() === committed).toBe(true);
  });

  it("is plain data: no imports, so browsers can load it as is", () => {
    const committed = readFileSync(fromRoot(...DETERMINISM_VECTORS_FILE), "utf8");
    expect(committed).not.toMatch(/^\s*import\b|\brequire\(/m);
  });
});
