import { cpus } from "node:os";
import { parseArgs } from "node:util";
import {
  buildCodecWorkload,
  codecStrictFailure,
  formatCodecBench,
  runCodecBench,
} from "./codec.bench";
import { formatInterpBench, interpStrictFailure, loadArena, runInterpBench } from "./interp.bench";
import {
  buildPmoveWorkload,
  formatPmoveBench,
  pmoveStrictFailure,
  runPmoveBench,
} from "./pmove.bench";
import {
  buildSnapshotBuildWorkload,
  buildStrictFailure,
  formatSnapshotBuildBench,
  runSnapshotBuildBench,
} from "./snapshotBuild.bench";
import {
  buildTraceWorkload,
  formatTraceBench,
  loadMovementLab,
  runTraceBench,
  strictFailure,
} from "./trace.bench";

// `pnpm bench`: sim microbenchmarks against the docs/10 §4.4 budgets (the interp frame is
// reported against its estimate): BVH traces, pmove, the snapshot and INPUT codecs, the remote
// interpolation frame and the server's snapshot build. Timings vary by machine, so a miss only fails the run with
// --strict.
const { values } = parseArgs({
  options: {
    strict: { type: "boolean", default: false },
    calls: { type: "string", default: "1000000" },
    warmup: { type: "string", default: "100000" },
    // pmove: match ticks of PMOVE_PLAYERS players each.
    "pmove-ticks": { type: "string", default: "12500" },
    "pmove-warmup": { type: "string", default: "12500" },
    // codec: snapshot and INPUT round trips each.
    "codec-calls": { type: "string", default: "1000000" },
    "codec-warmup": { type: "string", default: "100000" },
    // interp: receiver frames per case.
    "interp-frames": { type: "string", default: "200000" },
    "interp-warmup": { type: "string", default: "50000" },
    // snapshot build: server ticks of 16 clients each.
    "build-ticks": { type: "string", default: "20000" },
    "build-warmup": { type: "string", default: "5000" },
  },
});

const calls = Number(values.calls);
const warmup = Number(values.warmup);
const pmoveTicks = Number(values["pmove-ticks"]);
const pmoveWarmup = Number(values["pmove-warmup"]);
const codecCalls = Number(values["codec-calls"]);
const codecWarmup = Number(values["codec-warmup"]);
const interpFrames = Number(values["interp-frames"]);
const interpWarmup = Number(values["interp-warmup"]);
const buildTicks = Number(values["build-ticks"]);
const buildWarmup = Number(values["build-warmup"]);
const positive = (x: number) => Number.isInteger(x) && x >= 1;
const nonNegative = (x: number) => Number.isInteger(x) && x >= 0;
if (
  !positive(calls) ||
  !nonNegative(warmup) ||
  !positive(pmoveTicks) ||
  !nonNegative(pmoveWarmup) ||
  !positive(codecCalls) ||
  !nonNegative(codecWarmup) ||
  !positive(interpFrames) ||
  !nonNegative(interpWarmup) ||
  !positive(buildTicks) ||
  !nonNegative(buildWarmup)
) {
  console.error(
    "--calls, --pmove-ticks, --codec-calls, --interp-frames and --build-ticks must be positive integers, --warmup, --pmove-warmup, --codec-warmup, --interp-warmup and --build-warmup non-negative ones",
  );
  process.exit(2);
}

console.log(`node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}`);
const world = loadMovementLab();
const result = await runTraceBench(buildTraceWorkload(world), calls, warmup);
console.log(formatTraceBench(result, world));
console.log("");
const pmoveWorkload = buildPmoveWorkload();
const pmoveResult = await runPmoveBench(pmoveWorkload, pmoveTicks, pmoveWarmup);
console.log(formatPmoveBench(pmoveResult, pmoveWorkload));
console.log("");
const codecResult = await runCodecBench(buildCodecWorkload(), codecCalls, codecWarmup);
console.log(formatCodecBench(codecResult));
console.log("");
const interpResult = await runInterpBench(loadArena(), interpFrames, interpWarmup);
console.log(formatInterpBench(interpResult));
console.log("");
const buildResult = await runSnapshotBuildBench(
  buildSnapshotBuildWorkload(),
  buildTicks,
  buildWarmup,
);
console.log(formatSnapshotBuildBench(buildResult));
if (
  values.strict &&
  (strictFailure(result) ||
    pmoveStrictFailure(pmoveResult) ||
    codecStrictFailure(codecResult) ||
    interpStrictFailure(interpResult) ||
    buildStrictFailure(buildResult))
) {
  process.exitCode = 1;
}
