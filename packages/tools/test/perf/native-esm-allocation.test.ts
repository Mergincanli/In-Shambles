import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fromRoot } from "../../src/paths";

// The per-tick paths (quantizePlayerState, snapOrigin, the state ring, copy/equals,
// sanitizeUserCmd and the BVH queries) must not allocate under native ES modules either, where
// V8 boxes a double returned by a call it doesn't inline or joined with a module constant in a
// ternary. Vitest's module runner hides that, so this runs a child process.

interface ChildResult {
  clean: boolean;
  attempts: string[];
  outcomes: number[];
}

function runChild(workload: string): ChildResult {
  const out = spawnSync(
    process.execPath,
    ["--import", "tsx", "test/perf/nativeEsmAllocation.ts", workload],
    { cwd: fromRoot("packages", "tools"), encoding: "utf8" },
  );
  expect(out.status, out.stderr).toBe(0);
  return JSON.parse(out.stdout) as ChildResult;
}

describe("per-tick paths under native ES modules", () => {
  it("quantizePlayerState allocates nothing", () => {
    const r = runChild("quantize");
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("snapOrigin allocates nothing, on every outcome", () => {
    const r = runChild("snap");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("the state ring, copy/equals and sanitizeUserCmd allocate nothing", () => {
    const r = runChild("state");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("BVH queries allocate nothing", () => {
    const r = runChild("trace");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);
});
