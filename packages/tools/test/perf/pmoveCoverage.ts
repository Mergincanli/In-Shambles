import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";

// Child process of long/pmove-primer.long.ts (`pnpm test:long`, D-040, M3 design §2.11): block
// coverage of pmove (`packages/shared/src/sim/pmove/*`) by V8's precise coverage over
// node:inspector, for one of two runs in a fresh process: `primer` (primePmove for
// PMOVE_PRIMER_TICKS with the default parameters, as a match primes) or `mix` (the MV scenario
// mix: every feel-report scenario, which runs the MV-01–MV-18 setups on movement_lab, and the
// MV-19 determinism probe's 10k ticks over every course feature). Coverage starts before the
// sim's modules load, so every function gets its block counters. Prints one JSON line: per file,
// the script's source as V8 ran it (tsx's transform: both runs load the same text) and every
// range with its count.

const run = process.argv[2];
if (run !== "primer" && run !== "mix") throw new Error("usage: pmoveCoverage.ts primer|mix");

const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Debugger.enable");
await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });

if (run === "primer") {
  const shared = await import("@game/shared");
  shared.primePmove(new shared.PmoveParams(), shared.PMOVE_PRIMER_TICKS);
} else {
  const { measureFeel } = await import("../../src/reports/feelReport");
  const { coursePath } = await import("../../src/scenarios/course");
  const { runDeterminismProbe } = await import("../../src/scenarios/determinismProbe");
  measureFeel();
  runDeterminismProbe(new Uint8Array(readFileSync(coursePath("movement_lab"))));
}

const { result } = await session.post("Profiler.takePreciseCoverage");
const files: Record<string, { source: string; functions: { name: string; ranges: number[][] }[] }> =
  {};
for (const script of result) {
  const m = /\/shared\/src\/sim\/pmove\/([a-zA-Z]+)\.ts$/.exec(script.url);
  if (m === null) continue;
  const { scriptSource } = await session.post("Debugger.getScriptSource", {
    scriptId: script.scriptId,
  });
  // Per function (V8's order): its name and its ranges, outermost first.
  const functions = script.functions.map((f) => ({
    name: f.functionName,
    ranges: f.ranges.map((r) => [r.startOffset, r.endOffset, r.count]),
  }));
  files[m[1] as string] = { source: scriptSource, functions };
}
session.disconnect();
console.log(JSON.stringify({ run, files }));
