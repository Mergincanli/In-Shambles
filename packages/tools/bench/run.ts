import { cpus } from "node:os";
import { parseArgs } from "node:util";
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
  },
});

const calls = Number(values.calls);
const warmup = Number(values.warmup);
const pmoveTicks = Number(values["pmove-ticks"]);
const pmoveWarmup = Number(values["pmove-warmup"]);
const positive = (x: number) => Number.isInteger(x) && x >= 1;
const nonNegative = (x: number) => Number.isInteger(x) && x >= 0;
if (
  !positive(calls) ||
  !nonNegative(warmup) ||
  !positive(pmoveTicks) ||
  !nonNegative(pmoveWarmup)
) {
  console.error(
    "--calls and --pmove-ticks must be positive integers, --warmup and --pmove-warmup non-negative ones",
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
if (values.strict && (strictFailure(result) || pmoveStrictFailure(pmoveResult))) {
  process.exitCode = 1;
}
