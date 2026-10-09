import { describe, it } from "vitest";
import { buildTraceWorkload } from "../bench/trace.bench";
import { expectStartsClear, world } from "../test/bench/traceCases";

// The trace bench workload (docs/10 §4.4), its long tier (D-032): the full-size workloads of seeds
// 1 and 2 start every trace clear, as `packages/tools/test/bench/trace-bench.test.ts` checks for
// the default seed in `pnpm test`.

describe("trace bench workload", () => {
  it.each([1, 2])("starts every trace clear (seed %i, full size)", (seed) => {
    expectStartsClear(buildTraceWorkload(world, seed));
  });
});
