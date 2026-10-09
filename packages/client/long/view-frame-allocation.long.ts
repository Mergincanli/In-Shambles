import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The render frame's sim side (Game.frame: the client frame, step smoothing, eye height, the
// pose) must not allocate under native ES modules, where V8 boxes a double returned by a call it
// doesn't inline (a getter, say). Vitest's module runner hides that, so this runs a child process
// (as packages/tools/long/native-esm-allocation.long.ts does for the per-tick paths).

const clientDir = fileURLToPath(new URL("..", import.meta.url));

describe("view frame under native ES modules", () => {
  it("Game.frame allocates nothing: steps, crouch, turns, resyncs, mouse look, debug draw", () => {
    const out = spawnSync(
      process.execPath,
      ["--import", "tsx", "test/perf/viewFrameAllocation.ts"],
      { cwd: clientDir, encoding: "utf8" },
    );
    expect(out.status, out.stderr).toBe(0);
    const r = JSON.parse(out.stdout) as { clean: boolean; attempts: string[]; outcomes: number[] };
    // STEP events, crouched frames, hard resyncs, frames, debug traces and shapes.
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 60_000);

  it("the remote capsules' update allocates nothing: 16 remotes, teams, crouches, leaves", () => {
    const out = spawnSync(
      process.execPath,
      ["--import", "tsx", "test/perf/playersUpdateAllocation.ts"],
      { cwd: clientDir, encoding: "utf8" },
    );
    expect(out.status, out.stderr).toBe(0);
    const r = JSON.parse(out.stdout) as { clean: boolean; attempts: string[]; outcomes: number[] };
    // Capsules drawn, teleport marks, crouched draws, colour uploads.
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 60_000);
});
