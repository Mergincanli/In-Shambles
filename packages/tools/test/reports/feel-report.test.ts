import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PmoveParams } from "@game/shared";
import { describe, expect, it } from "vitest";
import { fromRoot } from "../../src/paths";
import {
  FEEL_METRICS,
  type FeelReport,
  formatFeelReport,
  measureFeel,
} from "../../src/reports/feelReport";

// `pnpm feel-report` (docs/03 §8, M2 design §5): every base metric is measured and printed, the
// checked ones meet their targets, and the written file is the same bytes in every process.

describe("feel report", () => {
  const report = measureFeel();
  const text = formatFeelReport(report);

  it("measures every metric once, in order, and each checked one meets its target", () => {
    expect(report.rows.map((r) => r.metric)).toEqual([...FEEL_METRICS]);
    for (const r of report.rows) {
      expect(r.ok, `${r.metric}: ${r.measured} vs ${r.target}`).not.toBe(false);
      expect(text).toContain(`| ${r.metric} | ${r.measured.replaceAll("|", "\\|")} |`);
    }
    expect(report.course).toBe("movement_lab");
    expect(text).toContain(report.contentHash);
  });

  it("flags a missed target: a slower run speed fails the run cap row", () => {
    const slow = new PmoveParams();
    slow.runSpeed = 300;
    const row = measureFeel(slow).rows.find((r) => r.metric === "Run cap");
    expect(row?.measured).toBe("300.00 u/s");
    expect(row?.ok).toBe(false);
  }, 30_000);

  it("formats a miss as NO, a report-only row as –, and counts only checked rows", () => {
    const synthetic: FeelReport = {
      course: "c",
      contentHash: "h",
      rows: [
        { section: "S", metric: "a", measured: "1", target: "2", ok: false },
        { section: "S", metric: "b", measured: "x|y", target: "-", ok: null },
        { section: "S", metric: "c", measured: "3", target: "3", ok: true },
      ],
    };
    const out = formatFeelReport(synthetic);
    expect(out).toContain("| S | a | 1 | 2 | NO |");
    expect(out).toContain("| S | b | x\\|y | - | – |");
    expect(out).toContain("| S | c | 3 | 3 | yes |");
    expect(out).toContain("1 of 2 checked metrics meet their target.");
  });

  it("git ignores the root reports/ folder only, not the report code", () => {
    const ignored = (path: string) =>
      spawnSync("git", ["check-ignore", "-q", path], { cwd: fromRoot() }).status === 0;
    expect(ignored("reports/feel.md")).toBe(true);
    expect(ignored("packages/tools/src/reports/feelReport.ts")).toBe(false);
    expect(ignored("packages/tools/test/reports/feel-report.test.ts")).toBe(false);
  });

  it("the CLI prints it and writes the same bytes to --out", () => {
    const dir = mkdtempSync(join(tmpdir(), "feel-report-"));
    try {
      const out = join(dir, "feel.md");
      const run = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/reports/cli.ts", "--out", out],
        { cwd: fromRoot("packages", "tools"), encoding: "utf8" },
      );
      expect(run.status, run.stderr).toBe(0);
      expect(readFileSync(out, "utf8")).toBe(text);
      expect(run.stdout).toContain(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
