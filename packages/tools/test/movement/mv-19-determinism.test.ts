import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coursePath } from "../../src/scenarios/course";
import {
  MV19_ANCHORS,
  MV19_TELEPORT_TICKS,
  MV19_TICKS,
  type ProbeResult,
  runDeterminismProbe,
} from "../../src/scenarios/determinismProbe";
import { logMeasured } from "../../src/scenarios/metrics";
import {
  bundleProbeWithServerBuild,
  bundleProbeWithVite,
  runProbeBundle,
} from "../../src/scenarios/probeBuilds";

/** The first line `packages/server/build.mjs` writes into every bundle (its esbuild banner). */
const SERVER_BUILD_BANNER =
  /^import \{ createRequire as __createRequire \} from "node:module"; const require = __createRequire\(import\.meta\.url\);\n/;

// docs/03 §8 MV-19, M2 design §5: the same inputs give bit-identical states over 10k ticks, run
// twice and across the client and server builds. A seeded sticky cmd stream on movement_lab, with
// a teleport to the next anchor every 1000 ticks, is digested every tick. The browser leg is the
// pmove vectors, which `pnpm test:browser` replays in Chromium, Firefox and WebKit (D-022).

const cmapPath = coursePath("movement_lab");
const bytes = () => new Uint8Array(readFileSync(cmapPath));

function firstDifference(a: Uint32Array, b: Uint32Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : a.length;
}

describe("MV-19: determinism across runs and builds", () => {
  const first = new Uint32Array(MV19_TICKS);
  const second = new Uint32Array(MV19_TICKS);
  // In hooks, not at collection, so a run filtered to another suite (-t "^BAL-") skips the work.
  let reference: ProbeResult;
  beforeAll(() => {
    reference = runDeterminismProbe(bytes(), MV19_TICKS, first);
  });

  it("two in-process runs give the same digest every tick", () => {
    const again = runDeterminismProbe(bytes(), MV19_TICKS, second);
    expect(firstDifference(first, second)).toBe(-1);
    expect(again).toEqual(reference);
    expect(reference.checkpoints).toHaveLength(MV19_TICKS / MV19_TELEPORT_TICKS);
    expect(reference.digest).toBe(first[MV19_TICKS - 1]);
  });

  it("the stream reaches every mode the courses offer", () => {
    const t = reference.tally;
    logMeasured(
      "MV-19",
      "probe mix",
      `${t.grounded} grounded, ${t.swimming} swimming, ${t.crouched} crouched, ${t.ladder} ladder ticks; ${t.jumps} jumps, ${t.steps} steps, ${t.lands} landings, ${t.snapRepairs} snap repairs over ${MV19_TICKS} ticks and ${MV19_ANCHORS.length} anchors`,
      "every mode reached",
    );
    expect(t.grounded).toBeGreaterThan(MV19_TICKS / 4);
    expect(t.swimming).toBeGreaterThan(0);
    expect(t.crouched).toBeGreaterThan(0);
    expect(t.ladder).toBeGreaterThan(0);
    expect(t.jumps).toBeGreaterThan(0);
    expect(t.steps).toBeGreaterThan(0);
    expect(t.lands).toBeGreaterThan(0);
    // Snap repairs are logged, not required: open course ground rarely needs one, and the pmove
    // vectors carry the corner snap into the browsers.
  });

  describe("bundled and run in plain Node", () => {
    let outDir = "";
    beforeAll(() => {
      outDir = mkdtempSync(join(tmpdir(), "mv19-"));
    });
    afterAll(() => {
      if (outDir !== "") rmSync(outDir, { recursive: true, force: true, maxRetries: 5 });
    });

    it.each([
      ["the server's esbuild build", async () => bundleProbeWithServerBuild(outDir)],
      ["Vite library mode, minified", () => bundleProbeWithVite(outDir)],
    ])(
      "%s gives the same digests",
      async (_name, bundle) => {
        const file = await bundle();
        // The server build starts every bundle with a `require` for its CommonJS dependencies
        // (ws; packages/server/build.mjs): build preamble, not part of the sim.
        const source = readFileSync(file, "utf8").replace(SERVER_BUILD_BANNER, "");
        // The sim is inside the bundle, and it needs nothing from Node.
        expect(source).not.toMatch(/@game\/shared|["']node:/);
        expect(runProbeBundle(file, cmapPath)).toEqual(reference);
      },
      30_000,
    );
  });
});
