import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  childCpuFromProcStat,
  formatTestCost,
  TestCostReporter,
} from "../../../../scripts/test-cost-reporter.mjs";
import fastConfig from "../../../../vitest.config";
import longConfig, { LONG_GLOB } from "../../../../vitest.long.config";
import { fromRoot } from "../../src/paths";

// The test tiers (D-032, M3 design §2.16): `pnpm test` (fast, every `*.test.ts` under a package)
// and `pnpm test:long` (`*.long.ts` under `packages/<pkg>/long/`, blocking in CI), each with its
// budget reported by the test-cost reporter. A file in the wrong place would run in no tier, or
// in both: these checks keep every test in exactly one. The guard's describes must not start with
// an ID prefix.

const rootScripts: Record<string, string> = JSON.parse(
  readFileSync(fromRoot("package.json"), "utf8"),
).scripts;

/** Every file under packages/ (relative, `/`-separated), node_modules left out. */
const packageFiles = readdirSync(fromRoot("packages"), { recursive: true, encoding: "utf8" })
  .filter((file) => !file.includes("node_modules"))
  .map((file) => file.replaceAll("\\", "/"));

const longFiles = packageFiles.filter((file) => file.endsWith(".long.ts"));

function costReporter(config: { test?: { reporters?: unknown } }): TestCostReporter | undefined {
  const reporters = config.test?.reporters;
  return Array.isArray(reporters)
    ? reporters.find((r): r is TestCostReporter => r instanceof TestCostReporter)
    : undefined;
}

describe("test tiers", () => {
  it("run the long tier with its own config, pinned whole", () => {
    // A trailing path or `--project` would narrow the run and still exit 0.
    expect(rootScripts["test:long"]).toBe("vitest run --config vitest.long.config.ts");
    expect(rootScripts.test).toBe("vitest run");
  });

  it("give the long config exactly the long files, and the fast one every package's tests", () => {
    expect(LONG_GLOB).toBe("packages/*/long/**/*.long.ts");
    expect(longConfig.test?.include).toEqual([LONG_GLOB]);
    expect(longConfig.test?.projects).toBeUndefined();
    expect(fastConfig.test?.projects).toEqual(["packages/*"]);
    expect(fastConfig.test?.include).toBeUndefined();
  });

  it("keep every long file under packages/<pkg>/long, and no fast test there", () => {
    expect(longFiles.length).toBeGreaterThan(0);
    for (const file of longFiles) expect(file).toMatch(/^[^/]+\/long\//);
    // A `*.test.ts` in long/ would run in `pnpm test` too (the projects' default include).
    const fastInLong = packageFiles.filter((f) => /^[^/]+\/long\/.*\.test\.[cm]?[jt]sx?$/.test(f));
    expect(fastInLong).toEqual([]);
  });

  it("name an ID's long file after it, with its top-level describe", () => {
    for (const file of longFiles) {
      const id = /^(net|mv|bal)-(\d+)-/i.exec(basename(file));
      if (id === null) continue;
      const prefix = `${(id[1] as string).toUpperCase()}-${id[2]}`;
      const source = readFileSync(join(fromRoot("packages"), file), "utf8").replace(
        /\/\*[\s\S]*?\*\//g,
        "",
      );
      expect(source, file).toMatch(
        new RegExp(`^describe(\\.each\\([^\\n]*\\))?\\(\\s*["'\`]${prefix}\\b`, "m"),
      );
    }
  });

  it("block CI on the long tier, after the fast one, in the check job", () => {
    const ci = readFileSync(fromRoot(".github", "workflows", "ci.yml"), "utf8");
    // The check job: from its key to the next job key (two-space indent).
    const check = /^ {2}check:\n([\s\S]*?)(?=^ {2}[a-z][\w-]*:\n|(?![\s\S]))/m.exec(ci)?.[1] ?? "";
    const runs = [...check.matchAll(/^ {6}- run: (.+)$/gm)].map((m) => m[1]);
    expect(runs).toContain("pnpm test:long");
    expect(runs.indexOf("pnpm test:long")).toBe(runs.indexOf("pnpm test") + 1);
    expect(check).not.toMatch(/continue-on-error/);
  });

  it("report each tier's cost against its budget", () => {
    expect(costReporter(fastConfig)?.budget).toEqual({
      label: "pnpm test",
      wallSeconds: 55,
      cpuSeconds: 165,
    });
    expect(costReporter(longConfig)?.budget).toEqual({ label: "pnpm test:long", wallSeconds: 240 });
    // The default reporter stays first, so the cost line comes after its summary.
    expect(fastConfig.test?.reporters).toContain("default");
    expect(longConfig.test?.reporters).toContain("default");
  });
});

describe("the test-cost reporter", () => {
  it("reads the reaped children's CPU time from /proc/<pid>/stat", () => {
    // pid, a command name with spaces and a parenthesis, state, then fields 4–17: cutime (16)
    // and cstime (17) are 1234 and 56 clock ticks.
    const stat = "4242 (node (vitest) x) S 1 2 3 4 5 6 7 8 9 10 11 12 1234 56 20 0 7 0 99";
    expect(childCpuFromProcStat(stat, 100)).toEqual({ user: 12.34, sys: 0.56 });
    expect(childCpuFromProcStat(stat, 0)).toBeNull();
    expect(childCpuFromProcStat("no parenthesis here", 100)).toBeNull();
    expect(childCpuFromProcStat("1 (x) S 1 2", 100)).toBeNull();
  });

  it("prints wall and CPU time with the budget, marking what is over", () => {
    const fast = { label: "pnpm test", wallSeconds: 55, cpuSeconds: 165 };
    expect(formatTestCost(fast, 41.26, { user: 110, sys: 12.5 })).toBe(
      "test cost: 41.3 s wall, 122.5 CPU-s (user 110.0 + sys 12.5); " +
        "pnpm test budget ≤ 55 s wall, ≤ 165 CPU-s (D-032)",
    );
    expect(formatTestCost(fast, 56, { user: 160, sys: 6 })).toBe(
      "test cost: 56.0 s wall, 166.0 CPU-s (user 160.0 + sys 6.0); " +
        "pnpm test budget ≤ 55 s wall OVER, ≤ 165 CPU-s OVER (D-032)",
    );
    expect(formatTestCost({ label: "pnpm test:long", wallSeconds: 240 }, 20, null)).toBe(
      "test cost: 20.0 s wall, CPU time not measured (no /proc/self/stat); " +
        "pnpm test:long budget ≤ 240 s wall (D-032)",
    );
    // A narrowed run (`pnpm test:net`, one file) is not judged against the whole run's budget.
    expect(formatTestCost(fast, 70, { user: 200, sys: 1 }, true)).toBe(
      "test cost: 70.0 s wall, 201.0 CPU-s (user 200.0 + sys 1.0); " +
        "a narrowed run: the pnpm test budget is for the whole run (D-032)",
    );
  });

  it("tells a narrowed run from a whole one", async () => {
    const narrowedBy = async (
      config: { testNamePattern?: RegExp; project?: string[] },
      run: number,
      all: number,
    ) => {
      const r = new TestCostReporter({ label: "pnpm test", wallSeconds: 55, cpuSeconds: 165 });
      const specs = (n: number) => Array.from({ length: n }, () => ({}));
      // Only what the reporter reads of Vitest: its config and the unfiltered file list.
      const vitest = { config, globTestSpecifications: async () => specs(all) };
      r.onInit(vitest as unknown as Parameters<TestCostReporter["onInit"]>[0]);
      await r.onTestRunStart(
        specs(run) as unknown as Parameters<TestCostReporter["onTestRunStart"]>[0],
      );
      return r.narrowed;
    };
    expect(await narrowedBy({}, 143, 143)).toBe(false);
    expect(await narrowedBy({ project: [] }, 143, 143)).toBe(false);
    expect(await narrowedBy({}, 1, 143)).toBe(true);
    expect(await narrowedBy({ testNamePattern: /^NET-/ }, 143, 143)).toBe(true);
    expect(await narrowedBy({ project: ["@game/tools"] }, 40, 40)).toBe(true);
  });
});
