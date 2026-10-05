import { writeFileSync } from "node:fs";
import { fromRoot } from "../paths";
import { DETERMINISM_VECTORS_FILE, renderDeterminismVectors } from "./determinism";

// `pnpm --filter @game/tools vectors`: rewrites the committed determinism vectors.
const path = fromRoot(...DETERMINISM_VECTORS_FILE);
writeFileSync(path, renderDeterminismVectors());
console.log(`wrote ${path}`);
