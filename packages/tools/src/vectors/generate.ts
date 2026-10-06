import { writeFileSync } from "node:fs";
import { fromRoot } from "../paths";
import { DETERMINISM_VECTORS_FILE, renderDeterminismVectors } from "./determinism";
import { PMOVE_VECTORS_FILE, renderPmoveVectors } from "./pmove";
import { renderTraceVectors, TRACE_VECTORS_FILE } from "./trace";

// `pnpm --filter @game/tools vectors`: rewrites the committed determinism, trace and pmove vectors.
for (const [file, render] of [
  [DETERMINISM_VECTORS_FILE, renderDeterminismVectors],
  [TRACE_VECTORS_FILE, renderTraceVectors],
  [PMOVE_VECTORS_FILE, renderPmoveVectors],
] as const) {
  const path = fromRoot(...file);
  writeFileSync(path, render());
  console.log(`wrote ${path}`);
}
