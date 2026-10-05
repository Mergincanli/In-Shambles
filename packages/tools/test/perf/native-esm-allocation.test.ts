import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fromRoot } from "../../src/paths";

// The end-of-tick path (quantizePlayerState, snapOrigin) must not allocate under native ES
// modules either, where V8 boxes a double returned by a call it doesn't inline or joined with a
// module constant in a ternary. Vitest's module runner hides that, so this runs a child process.

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

describe("end-of-tick path under native ES modules", () => {
  it("quantizePlayerState allocates nothing", () => {
    const r = runChild("quantize");
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("snapOrigin allocates nothing, on every outcome", () => {
    const r = runChild("snap");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);
});
