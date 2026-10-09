import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PMOVE_PLAYERS } from "../bench/pmove.bench";
import { fromRoot } from "../src/paths";

// The `pnpm bench` CLI part by part (docs/10 §4.4), the long tier's (D-032): each part's report
// after the one before it, with that part's counts raised, and every refused count exiting 2. Each
// case is a `node --import tsx bench/run.ts` child. `pnpm test` keeps one end-to-end smoke of all
// five parts with tiny counts (`packages/tools/test/bench/trace-bench.test.ts`) and the
// workloads' and verdicts' unit tests.

describe("pnpm bench entry", () => {
  // Short pmove and codec parts: pmove-bench.test.ts and codec-bench.test.ts cover them.
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "bench/run.ts",
        "--build-ticks",
        "20",
        "--build-warmup",
        "0",
        "--pmove-ticks",
        "20",
        "--pmove-warmup",
        "0",
        "--codec-calls",
        "1000",
        "--codec-warmup",
        "0",
        "--interp-frames",
        "1000",
        "--interp-warmup",
        "0",
        ...args,
      ],
      { cwd: fromRoot("packages", "tools"), encoding: "utf8" },
    );

  it("prints the machine, the table and the verdict, and exits 0", () => {
    const out = run("--calls", "1000", "--warmup", "1000");
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/^node v\d+\.\d+\.\d+, \S/);
    expect(out.stdout).toMatch(/budget 1000 ns: (PASS|FAIL)/);
    expect(out.stdout).toMatch(/GCs during timed loops: \d+/);
  }, 30_000);

  it("rejects bad counts with exit code 2", () => {
    expect(run("--calls", "0").status).toBe(2);
    expect(run("--warmup", "1.5").status).toBe(2);
  }, 30_000);
});

describe("pnpm bench entry, pmove part", () => {
  // A short codec part: codec-bench.test.ts covers it.
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "bench/run.ts",
        "--build-ticks",
        "20",
        "--build-warmup",
        "0",
        "--calls",
        "1000",
        "--warmup",
        "1000",
        "--codec-calls",
        "1000",
        "--codec-warmup",
        "0",
        "--interp-frames",
        "1000",
        "--interp-warmup",
        "0",
        ...args,
      ],
      { cwd: fromRoot("packages", "tools"), encoding: "utf8" },
    );

  it("prints the pmove report after the trace report, and exits 0", () => {
    const out = run("--pmove-ticks", "50", "--pmove-warmup", "50");
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/budget 1000 ns: (PASS|FAIL)[\s\S]*budget 5000 ns: (PASS|FAIL)/);
    expect(out.stdout).toContain(`pmove on movement_lab: ${PMOVE_PLAYERS} players`);
    expect(out.stdout).toMatch(/GCs during the pmove loop: \d+/);
  }, 30_000);

  it("rejects bad pmove counts with exit code 2", () => {
    expect(run("--pmove-ticks", "0").status).toBe(2);
    expect(run("--pmove-warmup", "1.5").status).toBe(2);
  }, 30_000);
});

describe("pnpm bench entry, codec part", () => {
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "bench/run.ts",
        "--build-ticks",
        "20",
        "--build-warmup",
        "0",
        "--calls",
        "1000",
        "--warmup",
        "0",
        "--pmove-ticks",
        "20",
        "--pmove-warmup",
        "0",
        "--interp-frames",
        "1000",
        "--interp-warmup",
        "0",
        ...args,
      ],
      { cwd: fromRoot("packages", "tools"), encoding: "utf8" },
    );

  it("prints the codec report after the pmove report, and exits 0", () => {
    const out = run("--codec-calls", "2000", "--codec-warmup", "1000");
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/budget 5000 ns: (PASS|FAIL)[\s\S]*budget 30000 ns: (PASS|FAIL)/);
    expect(out.stdout).toMatch(/INPUT, 4 cmds \(55 B\) encode\+decode: [\d.]+ ns/);
    expect(out.stdout).toMatch(/failed round trips: 0/);
  }, 30_000);

  it("rejects bad codec counts with exit code 2", () => {
    expect(run("--codec-calls", "0").status).toBe(2);
    expect(run("--codec-warmup", "1.5").status).toBe(2);
  }, 30_000);
});

describe("pnpm bench entry, interp part", () => {
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "bench/run.ts",
        "--build-ticks",
        "20",
        "--build-warmup",
        "0",
        "--calls",
        "1000",
        "--warmup",
        "0",
        "--pmove-ticks",
        "20",
        "--pmove-warmup",
        "0",
        "--codec-calls",
        "1000",
        "--codec-warmup",
        "0",
        ...args,
      ],
      { cwd: fromRoot("packages", "tools"), encoding: "utf8" },
    );

  it("prints the interp report after the codec report, and exits 0", () => {
    const out = run("--interp-frames", "5000", "--interp-warmup", "2000");
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/budget 30000 ns: (PASS|FAIL)[\s\S]*interp frame: 5000 frames/);
    expect(out.stdout).toMatch(/clean stream: [\d.]+ ns per frame .*16\.00 drawn/);
    expect(out.stdout).toMatch(/12 of every 512 ticks lost: [\d.]+ ns per frame/);
  }, 30_000);

  it("rejects bad interp counts with exit code 2", () => {
    expect(run("--interp-frames", "0").status).toBe(2);
    expect(run("--interp-warmup", "1.5").status).toBe(2);
  }, 30_000);
});

describe("pnpm bench entry, snapshot build part", () => {
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "bench/run.ts",
        "--calls",
        "1000",
        "--warmup",
        "0",
        "--pmove-ticks",
        "20",
        "--pmove-warmup",
        "0",
        "--codec-calls",
        "1000",
        "--codec-warmup",
        "0",
        "--interp-frames",
        "1000",
        "--interp-warmup",
        "0",
        ...args,
      ],
      { cwd: fromRoot("packages", "tools"), encoding: "utf8" },
    );

  it("prints the snapshot build report after the interp report, and exits 0", () => {
    const out = run("--build-ticks", "2000", "--build-warmup", "1000");
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/interp frame: 1000 frames[\s\S]*snapshot build: 2000 ticks of 16/);
    expect(out.stdout).toMatch(/per client \(\d+ B, 100\.0% deltas\): [\d.]+ ns, budget 50000 ns/);
    expect(out.stdout).toMatch(/failed encodes: 0/);
  }, 30_000);

  it("rejects bad snapshot build counts with exit code 2", () => {
    expect(run("--build-ticks", "0").status).toBe(2);
    expect(run("--build-warmup", "1.5").status).toBe(2);
  }, 30_000);
});
