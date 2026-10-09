import { describe } from "vitest";
import { EVERY_PHASE, slopeApproaches } from "../test/movement/slopes";

// MV-06 (docs/03 §8 MV-06, §4.10, M2 design §5), its long tier (D-032): every slope approach of
// `packages/tools/test/movement/mv-06-slopes.test.ts` swept over every start phase, 64 u in 1/8 u
// steps (1/2 u on the 0.69 slope), where `pnpm test` sweeps a sample. Same approaches and checks
// (`slopes.ts`); that file's header says what they are.

describe("MV-06: slopes on movement_lab", () => {
  slopeApproaches(EVERY_PHASE);
});
