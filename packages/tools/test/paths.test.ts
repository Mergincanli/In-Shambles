import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromRoot, repoRoot } from "../src/paths";

describe("repoRoot", () => {
  it("finds the workspace root", () => {
    expect(existsSync(join(repoRoot(), "pnpm-workspace.yaml"))).toBe(true);
    expect(existsSync(fromRoot("docs", "09-roadmap.md"))).toBe(true);
  });

  it("throws outside the repo", () => {
    expect(() => repoRoot(tmpdir())).toThrow(/pnpm-workspace.yaml not found/);
  });
});
