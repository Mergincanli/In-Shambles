import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "vitest";
import { fromRoot } from "../src/paths";

// The per-tick paths (quantizePlayerState, snapOrigin, the state ring, copy/equals,
// sanitizeUserCmd, the pmove params refresh and basics, whole pmove ticks in every M2 move mode,
// the scenario runner and bots, the per-tick message codecs, the transports, the server's match
// tick and the Node server's timing wrapper, both ends of the WebSocket transport, the client's
// prediction and reconciliation, the remote interpolation, and the BVH queries) must not
// allocate under native ES modules either, where V8 boxes a double returned by a call it doesn't
// inline or joined with a module constant in a ternary. Vitest's module runner hides that, so
// this runs a child process.
//
// The children run two at a time: one after another this file took some 16 s alone (it set the
// floor of `pnpm test`, where it ran until D-032 moved it to `pnpm test:long`). Each child counts
// only its own GCs and heap, so a neighbour cannot add garbage to it; more at once would mostly
// slow the JIT warm-ups the measurements wait for.

interface ChildResult {
  clean: boolean;
  attempts: string[];
  outcomes: number[];
  /** wsTransport: the client end's outcomes; predict: [0] teleports; interp: [0] held. */
  extra: number[];
  /** codec only: hostile packets the decoders refused. */
  rejected: number;
}

const CHILDREN_AT_ONCE = 2;
const run = promisify(execFile);
let running = 0;
const waiting: (() => void)[] = [];

async function runChild(workload: string): Promise<ChildResult> {
  if (running >= CHILDREN_AT_ONCE) await new Promise<void>((go) => waiting.push(go));
  running++;
  try {
    // A failing child rejects with its stderr in the message.
    const out = await run(
      process.execPath,
      ["--import", "tsx", "test/perf/nativeEsmAllocation.ts", workload],
      { cwd: fromRoot("packages", "tools"), encoding: "utf8", maxBuffer: 1 << 20 },
    );
    return JSON.parse(out.stdout) as ChildResult;
  } finally {
    running--;
    waiting.shift()?.();
  }
}

describe.concurrent("per-tick paths under native ES modules", () => {
  it("quantizePlayerState allocates nothing", async ({ expect }) => {
    const r = await runChild("quantize");
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("snapOrigin allocates nothing, on every outcome", async ({ expect }) => {
    const r = await runChild("snap");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("the state ring, copy/equals and sanitizeUserCmd allocate nothing", async ({ expect }) => {
    const r = await runChild("state");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("refreshPmoveParams and the pmove basics allocate nothing", async ({ expect }) => {
    const r = await runChild("pmoveBasics");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("whole pmove ticks allocate nothing, with events and the trace log attached", async ({
    expect,
  }) => {
    const r = await runChild("pmove");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("pmove ticks on ladders, in water and crouched allocate nothing (D-024)", async ({
    expect,
  }) => {
    const r = await runChild("pmoveModes");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("the scenario runner and its hold and hop bots allocate nothing per tick (D-025)", async ({
    expect,
  }) => {
    const r = await runChild("scenario");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("the strafe bot's yaw search allocates nothing", async ({ expect }) => {
    const r = await runChild("strafeBot");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("the bots' route and random walk allocate nothing per tick (D-036)", async ({ expect }) => {
    const r = await runChild("botInput");
    // Waypoints reached, stuck detections, ticks spent random-walking out.
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("the INPUT, SNAPSHOT (full v2, 16 players), PING and PONG codecs allocate nothing, refusals included (D-026, D-033)", async ({
    expect,
  }) => {
    const r = await runChild("codec");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    // Every message came back: snapshots and inputs are a quarter each, pings and pongs a half.
    expect(r.outcomes[0]).toBe(r.outcomes[1]);
    expect(r.outcomes[2]).toBe(2 * (r.outcomes[0] as number));
    // And every hostile packet, one per message, was refused, in each run of 200000 calls.
    expect(r.rejected).toBeGreaterThan(0);
    expect(r.rejected % 200_000).toBe(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("the loopback pair and NetSim allocate nothing per packet after warm-up (D-026, D-028)", async ({
    expect,
  }) => {
    const r = await runChild("transport");
    // Raw loopback deliveries, NetSim unreliable deliveries, NetSim reliable deliveries.
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("the Node server's TimedPass and its tick histograms allocate nothing per pass (D-029)", async ({
    expect,
  }) => {
    const r = await runChild("timedPass");
    // Passes run; a match's and the pass's last 1 s window were closed with real values.
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("both WebSocket transport ends allocate nothing per arrival, poll or client send (D-030)", async ({
    expect,
  }) => {
    const r = await runChild("wsTransport");
    // Reliable deliveries, zero-length markers for oversized messages, drop-oldest losses; on
    // both ends, and the client's sends.
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    for (const n of r.extra) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("a match tick allocates nothing in steady state: inputs, starved repeats, pmove, snapshots, pongs (D-027)", async ({
    expect,
  }) => {
    const r = await runChild("match");
    // Snapshots decoded, starved snapshots among them, pongs.
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("client prediction allocates nothing: frames, predict, reconcile with re-simulation, clock steps (adaptive buffer included), hard resyncs, render offset, respawn teleports (D-027, D-028, D-035)", async ({
    expect,
  }) => {
    const r = await runChild("predict");
    // Corrections (dropped inputs), clock steps (the delay steps run every phase; this counts the
    // ones in the slow-host phase, the low edge's), hard resyncs (frame hitches); teleports
    // (respawns, D-035).
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.extra[0]).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("remote interpolation allocates nothing per frame: 16 remotes, extrapolation traces, holds, rejoins, teleports, removals, events (D-037)", async ({
    expect,
  }) => {
    const r = await runChild("interp");
    // Extrapolated or held remote-frames (the outages), surfaced events, frames the NET-05 meter
    // judged; held ones among the first.
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.extra[0]).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);

  it("BVH queries allocate nothing", async ({ expect }) => {
    const r = await runChild("trace");
    for (const n of r.outcomes) expect(n).toBeGreaterThan(0);
    expect(r.clean, r.attempts.join("; ")).toBe(true);
  }, 30_000);
});
