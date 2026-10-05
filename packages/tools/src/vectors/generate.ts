import { writeFileSync } from "node:fs";
import { fromRoot } from "../paths";
import { DETERMINISM_VECTORS_FILE, renderDeterminismVectors } from "./determinism";
import { renderTraceVectors, TRACE_VECTORS_FILE } from "./trace";

// `pnpm --filter @game/tools vectors`: rewrites the committed determinism and trace vectors.
for (const [file, render] of [
  [DETERMINISM_VECTORS_FILE, renderDeterminismVectors],
  [TRACE_VECTORS_FILE, renderTraceVectors],
] as const) {
  const path = fromRoot(...file);
  writeFileSync(path, render());
  console.log(`wrote ${path}`);
}
