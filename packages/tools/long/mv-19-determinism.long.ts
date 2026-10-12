import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coursePath } from "../src/scenarios/course";
import {
  MV19_TICKS,
  type ProbeResult,
  runDeterminismProbe,
} from "../src/scenarios/determinismProbe";
import { bundleProbeWithVite, runProbeBundle } from "../src/scenarios/probeBuilds";

// MV-19 (docs/03 §8 MV-19, M2 design §5), its long tier (D-032): the determinism probe bundled the
// way the client is built (Vite library mode, minified) and run in a plain `node` gives the
// in-process run's digests. `packages/tools/test/movement/mv-19-determinism.test.ts` runs the
// in-process repeat and the server build's leg in `pnpm test`.

const cmapPath = coursePath("movement_lab");

describe("MV-19: determinism across runs and builds", () => {
  // In hooks, not at collection, so a run filtered to another suite (-t "^NET-") skips the work.
  let reference: ProbeResult;
  let outDir = "";
  beforeAll(() => {
    reference = runDeterminismProbe(
      new Uint8Array(readFileSync(cmapPath)),
      MV19_TICKS,
      new Uint32Array(MV19_TICKS),
    );
    outDir = mkdtempSync(join(tmpdir(), "mv19-"));
  });
  afterAll(() => {
    if (outDir !== "") rmSync(outDir, { recursive: true, force: true, maxRetries: 5 });
  });

  describe("bundled and run in plain Node", () => {
    it("Vite library mode, minified gives the same digests", async () => {
      const file = await bundleProbeWithVite(outDir);
      const source = readFileSync(file, "utf8");
      // The sim is inside the bundle, and it needs nothing from Node.
      expect(source).not.toMatch(/@game\/shared|["']node:/);
      expect(runProbeBundle(file, cmapPath)).toEqual(reference);
    }, 30_000);
  });
});
