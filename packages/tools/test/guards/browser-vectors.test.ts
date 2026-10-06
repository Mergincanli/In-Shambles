import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import browserConfig, {
  ENGINES,
  parseBrowsers,
  VECTORS_GLOB,
} from "../../../../vitest.browser.config";
import { fromRoot } from "../../src/paths";

// D-022: `pnpm test:browser` replays packages/shared/test/*-vectors.test.ts in browser engines,
// so everything they load must run there: relative modules and `vitest` only.
const testDir = fromRoot("packages", "shared", "test");
const vectorTests = readdirSync(testDir)
  .filter((file) => file.endsWith("-vectors.test.ts"))
  .map((file) => join(testDir, file));

// `import x from "m"`, `export … from "m"`, `import "m"` and `import("m")`.
const SPECIFIER =
  /(?:^|\s)(?:import|export)\s[^"';]*?from\s+["']([^"']+)["']|import\s*\(?\s*["']([^"']+)["']/gm;

/** Every module reachable from `entry` through relative imports, with its bare imports. */
function importGraph(entry: string) {
  const seen = new Set<string>();
  const bare: string[] = [];
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const spec = match[1] ?? match[2] ?? "";
      if (!spec.startsWith(".")) {
        bare.push(`${relative(fromRoot(), file)}: ${spec}`);
        continue;
      }
      const base = join(dirname(file), spec);
      const resolved = [base, `${base}.ts`, join(base, "index.ts")].find(
        (path) => path.endsWith(".ts") && existsSync(path),
      );
      expect(resolved, `${relative(fromRoot(), file)}: ${spec}`).toBeDefined();
      if (resolved !== undefined) queue.push(resolved);
    }
  }
  return { modules: seen, bare };
}

describe("browser vectors (D-022)", () => {
  // The pmove vectors are MV-19's browser leg (docs/10 §1): renaming one off the glob must fail.
  it("finds the determinism, trace and pmove vectors", () => {
    expect(vectorTests.map((file) => relative(testDir, file)).sort()).toEqual(
      expect.arrayContaining([
        "determinism-vectors.test.ts",
        "pmove-vectors.test.ts",
        "trace-vectors.test.ts",
      ]),
    );
  });

  it.each(vectorTests.map((file) => [relative(testDir, file), file]))(
    "%s loads only relative modules and vitest",
    (_name, file) => {
      const { modules, bare } = importGraph(file);
      expect(modules.size).toBeGreaterThan(1);
      expect(bare.filter((entry) => !entry.endsWith(": vitest"))).toEqual([]);
    },
  );

  it("replays them in headless browser mode, default chromium", () => {
    const test = browserConfig.test;
    expect(test?.include).toEqual([VECTORS_GLOB]);
    expect(VECTORS_GLOB).toBe("packages/shared/test/*-vectors.test.ts");
    expect(test?.browser?.enabled).toBe(true);
    expect(test?.browser?.headless).toBe(true);
    if (process.env.BROWSERS === undefined) {
      expect(test?.browser?.instances?.map((instance) => instance.browser)).toEqual(["chromium"]);
    }
  });

  it("parses BROWSERS strictly", () => {
    expect(parseBrowsers(undefined)).toEqual(["chromium"]);
    expect(parseBrowsers(" webkit , firefox ")).toEqual(["webkit", "firefox"]);
    expect(parseBrowsers(ENGINES.join(","))).toEqual([...ENGINES]);
    for (const bad of ["", ",", "foo", "Chromium", "chromium,foo", "chromium,chromium"]) {
      expect(() => parseBrowsers(bad), bad).toThrow(/BROWSERS must list distinct names/);
    }
  });

  it("run in all three engines in the CI browsers job", () => {
    const ci = readFileSync(fromRoot(".github", "workflows", "ci.yml"), "utf8");
    const job = ci.split(/^ {2}browsers:$/m)[1]?.split(/^ {2}\S/m)[0] ?? "";
    // One entry per step, comments dropped, so a commented-out or split-up step does not count.
    const steps = job
      .replace(/^\s*#.*$/gm, "")
      .split(/^ {6}- /m)
      .slice(1);
    const install = steps.findIndex((step) =>
      /^run: pnpm exec playwright install --with-deps chromium firefox webkit\s*$/m.test(step),
    );
    const run = steps.filter((step) => /^run: pnpm test:browser\s*$/m.test(step));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(run).toHaveLength(1);
    expect(run[0]).toMatch(/^ {8}env:\n {10}BROWSERS: chromium,firefox,webkit\s*$/m);
    expect(steps.indexOf(run[0] ?? "")).toBeGreaterThan(install);
  });
});
