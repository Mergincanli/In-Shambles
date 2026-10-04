import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromRoot } from "../../src/paths";

/** tsconfig files are JSONC: drop comments before parsing (no string in them contains //). */
function readJsonc(...path: string[]): { compilerOptions?: Record<string, unknown> } {
  const text = readFileSync(fromRoot(...path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(text);
}

// The compiler is the first line of defence for golden rule 4 and docs/06 §2.
describe("tsconfig guard", () => {
  it("keeps TypeScript strict everywhere", () => {
    expect(readJsonc("tsconfig.base.json").compilerOptions?.strict).toBe(true);
  });

  it("keeps DOM and Node types out of packages/shared and checks indexed access", () => {
    const options = readJsonc("packages", "shared", "tsconfig.json").compilerOptions;
    expect(options?.lib).toEqual(["ES2023"]);
    expect(options?.types).toEqual([]);
    expect(options?.noUncheckedIndexedAccess).toBe(true);
  });
});
