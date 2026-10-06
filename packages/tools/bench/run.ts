import { cpus } from "node:os";
import { parseArgs } from "node:util";
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
  },
});

const calls = Number(values.calls);
const warmup = Number(values.warmup);
if (!Number.isInteger(calls) || calls < 1 || !Number.isInteger(warmup) || warmup < 0) {
  console.error("--calls must be a positive integer and --warmup a non-negative one");
  process.exit(2);
}

console.log(`node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}`);
const world = loadMovementLab();
const result = await runTraceBench(buildTraceWorkload(world), calls, warmup);
console.log(formatTraceBench(result, world));
if (values.strict && strictFailure(result)) process.exitCode = 1;
