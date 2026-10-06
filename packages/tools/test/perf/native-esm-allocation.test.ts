import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fromRoot } from "../../src/paths";

// The per-tick paths (quantizePlayerState, snapOrigin, the state ring, copy/equals,
// sanitizeUserCmd, the pmove params refresh and basics, whole pmove ticks in every M2 move mode,
// the scenario runner and bots, the per-tick message codecs, the transports, the server's match
// tick, the client's prediction and reconciliation, and the BVH queries)
// must not allocate under native ES modules either, where V8 boxes a double returned by a call it
// doesn't inline or joined with a module constant in a ternary. Vitest's module runner hides
// that, so this runs a child process.

interface ChildResult {
  clean: boolean;
  attempts: string[];
  outcomes: number[];
  /** codec only: hostile packets the decoders refused. */
  rejected: number;
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

  it("refreshPmoveParams and the pmove basics allocate nothing", () => {
    const r = runChild("pmoveBasics");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("whole pmove ticks allocate nothing, with events and the trace log attached", () => {
    const r = runChild("pmove");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("pmove ticks on ladders, in water and crouched allocate nothing (D-024)", () => {
    const r = runChild("pmoveModes");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("the scenario runner and its hold and hop bots allocate nothing per tick (D-025)", () => {
    const r = runChild("scenario");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("the strafe bot's yaw search allocates nothing", () => {
    const r = runChild("strafeBot");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("the INPUT, SNAPSHOT, PING and PONG codecs allocate nothing, refusals included (D-026)", () => {
    const r = runChild("codec");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    // Every message came back: snapshots and inputs are a quarter each, pings and pongs a half.
    expect(r.outcomes[0]).toBe(r.outcomes[1]);
    expect(r.outcomes[2]).toBe(2 * (r.outcomes[0] as number));
    // And every hostile packet, one per message, was refused, in each run of 200000 calls.
    expect(r.rejected).toBeGreaterThan(0);
    expect(r.rejected % 200_000).toBe(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("the loopback pair and NetSim allocate nothing per packet after warm-up (D-026, D-028)", () => {
    const r = runChild("transport");
    // Raw loopback deliveries, NetSim unreliable deliveries, NetSim reliable deliveries.
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("a match tick allocates nothing in steady state: inputs, starved repeats, pmove, snapshots, pongs (D-027)", () => {
    const r = runChild("match");
    // Snapshots decoded, starved snapshots among them, pongs.
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("client prediction allocates nothing: frames, predict, reconcile with re-simulation, clock steps, hard resyncs, render offset (D-027, D-028)", () => {
    const r = runChild("predict");
    // Corrections (dropped inputs), clock steps (input delay steps), hard resyncs (frame hitches).
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("BVH queries allocate nothing", () => {
    const r = runChild("trace");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);
});
