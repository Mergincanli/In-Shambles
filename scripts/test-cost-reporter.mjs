// Prints what a Vitest run cost, wall and CPU time, against its tier's budget (D-032, M3 design
// §2.16): `pnpm test` ≤ 55 s wall and ≤ 165 CPU-s, `pnpm test:long` ≤ 4 min wall. The budget is
// reported, never enforced: a shared CI runner's speed is not the code's. Both count from the
// Vitest process's start and are read as it exits, once it has reaped its test workers: wall time
// is its age, CPU time its own plus every child it reaped (the workers and the processes they
// waited for, as the shell's `time` counts them, within a second), read from `/proc/self/stat`,
// so it is Linux only; elsewhere the line says so. A narrowed run (file arguments, `-t`, as
// `pnpm test:net` is, or `--project`) prints its cost without the budget, which is for the whole
// run. vitest.config.ts and vitest.long.config.ts load it.
import { execFileSync } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";

/**
 * The reaped children's user and sys seconds from a `/proc/<pid>/stat` line (cutime and cstime,
 * fields 16 and 17, in clock ticks), or null when the line does not parse. The command name in
 * parentheses may hold spaces, so fields count from its closing parenthesis.
 */
export function childCpuFromProcStat(stat, clockTicks) {
  const close = stat.lastIndexOf(")");
  if (close < 0 || !(clockTicks > 0)) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // fields[0] is field 3 (state), so field n is fields[n − 3].
  const cutime = Number(fields[13]);
  const cstime = Number(fields[14]);
  if (!Number.isInteger(cutime) || !Number.isInteger(cstime)) return null;
  return { user: cutime / clockTicks, sys: cstime / clockTicks };
}

/**
 * One line: the run's wall and CPU time, then the budget, with OVER where it is missed; a
 * narrowed run is not judged against it.
 */
export function formatTestCost(budget, wallSeconds, cpu, narrowed = false) {
  const wallOver = wallSeconds > budget.wallSeconds ? " OVER" : "";
  let line = `test cost: ${wallSeconds.toFixed(1)} s wall`;
  let budgetText = `≤ ${budget.wallSeconds} s wall${wallOver}`;
  if (cpu === null) {
    line += ", CPU time not measured (no /proc/self/stat)";
  } else {
    const total = cpu.user + cpu.sys;
    line += `, ${total.toFixed(1)} CPU-s (user ${cpu.user.toFixed(1)} + sys ${cpu.sys.toFixed(1)})`;
    if (budget.cpuSeconds !== undefined) {
      const cpuOver = total > budget.cpuSeconds ? " OVER" : "";
      budgetText += `, ≤ ${budget.cpuSeconds} CPU-s${cpuOver}`;
    }
  }
  if (narrowed)
    return `${line}; a narrowed run: the ${budget.label} budget is for the whole run (D-032)`;
  return `${line}; ${budget.label} budget ${budgetText} (D-032)`;
}

function clockTicks() {
  try {
    return Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
  } catch {
    return 100;
  }
}

/** This process's CPU seconds plus its reaped children's, or null without /proc. */
function processTreeCpu() {
  let children = null;
  try {
    children = childCpuFromProcStat(readFileSync("/proc/self/stat", "utf8"), clockTicks());
  } catch {
    return null;
  }
  if (children === null) return null;
  const self = process.cpuUsage();
  return { user: self.user / 1e6 + children.user, sys: self.system / 1e6 + children.sys };
}

export class TestCostReporter {
  #armed = false;
  #vitest = undefined;
  #narrowed = false;

  constructor(budget) {
    this.budget = budget;
  }

  /** Whether this run was narrowed (known once it started). */
  get narrowed() {
    return this.#narrowed;
  }

  onInit(vitest) {
    this.#vitest = vitest;
  }

  /** Narrowed by a name or project filter, or by running fewer files than the config holds. */
  async onTestRunStart(specifications) {
    const v = this.#vitest;
    if (v === undefined) return;
    if (v.config.testNamePattern !== undefined || (v.config.project?.length ?? 0) > 0) {
      this.#narrowed = true;
      return;
    }
    const all = await v.globTestSpecifications();
    this.#narrowed = specifications.length < all.length;
  }

  onTestRunEnd() {
    if (this.#armed) return;
    this.#armed = true;
    // At the end of the run the last workers are still alive, so their CPU time is not yet
    // counted; at exit they are reaped. Exit handlers must write synchronously.
    process.once("exit", () => {
      // Node's performance.now() counts from the process's start.
      const wall = performance.now() / 1000;
      try {
        const line = formatTestCost(this.budget, wall, processTreeCpu(), this.#narrowed);
        writeSync(1, `${line}\n`);
      } catch {
        // stdout already closed: nothing to report to.
      }
    });
  }
}
