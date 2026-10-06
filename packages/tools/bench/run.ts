import { cpus } from "node:os";
import { parseArgs } from "node:util";
import {
  buildCodecWorkload,
  codecStrictFailure,
  formatCodecBench,
  runCodecBench,
} from "./codec.bench";
import {
  buildPmoveWorkload,
  formatPmoveBench,
  pmoveStrictFailure,
  runPmoveBench,
} from "./pmove.bench";
import {
  buildTraceWorkload,
  formatTraceBench,
  loadMovementLab,
  runTraceBench,
  strictFailure,
} from "./trace.bench";

// `pnpm bench`: sim microbenchmarks against the docs/10 §4.4 budgets. Timings vary by machine,
// so a miss only fails the run with --strict.
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
  },
});

const calls = Number(values.calls);
const warmup = Number(values.warmup);
const pmoveTicks = Number(values["pmove-ticks"]);
const pmoveWarmup = Number(values["pmove-warmup"]);
const codecCalls = Number(values["codec-calls"]);
const codecWarmup = Number(values["codec-warmup"]);
const positive = (x: number) => Number.isInteger(x) && x >= 1;
const nonNegative = (x: number) => Number.isInteger(x) && x >= 0;
if (
  !positive(calls) ||
  !nonNegative(warmup) ||
  !positive(pmoveTicks) ||
  !nonNegative(pmoveWarmup) ||
  !positive(codecCalls) ||
  !nonNegative(codecWarmup)
) {
  console.error(
    "--calls, --pmove-ticks and --codec-calls must be positive integers, --warmup, --pmove-warmup and --codec-warmup non-negative ones",
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
if (
  values.strict &&
  (strictFailure(result) || pmoveStrictFailure(pmoveResult) || codecStrictFailure(codecResult))
) {
  process.exitCode = 1;
}
