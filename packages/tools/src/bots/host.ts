import { readdirSync, readFileSync } from "node:fs";
import { cpus, getPriority, loadavg, setPriority } from "node:os";

/**
 * The bots' host rules (M3 design §2.15, D-045): a load run judges the server's tick times on the
 * wall clock, so it must not start on a busy host, and what generates the load (the bots, the
 * headless browser and the page's `vite preview`) runs below the server's priority, so the server
 * is measured, not the generators fighting it.
 */

/** The host gate: the 1-minute load average per core a run may start at (design). */
export const HOST_GATE_LOAD_PER_CORE = 0.5;
/** The generators' niceness: bots, headless Chromium and `vite preview` (design). */
export const GENERATOR_NICE = 10;

export interface HostGate {
  /** The 1-minute load average, or null where the host has none (Windows). */
  readonly load1: number | null;
  readonly cpus: number;
  readonly perCore: number | null;
  readonly pass: boolean;
  /**
   * False where there is no load average to judge (Windows, D-051): the check is reported, not
   * judged, and never stops a `--strict` run.
   */
  readonly measured: boolean;
  /** What the summary and a refused strict run print. */
  readonly text: string;
}

/** What the gate reads on a host without a load average (Windows, D-051). */
export const HOST_GATE_NOT_MEASURED = "not measured (no load average on Windows)";

/**
 * The gate on a 1-minute load average over `cpus` cores: a FAIL with the numbers, never a skip.
 * Without a load average (null: Windows, D-051) it is not measured: reported, not judged.
 */
export function hostGate(load1: number | null, cpus: number): HostGate {
  if (load1 === null) {
    return {
      load1,
      cpus,
      perCore: null,
      pass: true,
      measured: false,
      text: HOST_GATE_NOT_MEASURED,
    };
  }
  const perCore = cpus > 0 ? load1 / cpus : Number.POSITIVE_INFINITY;
  const pass = perCore <= HOST_GATE_LOAD_PER_CORE;
  // Two decimals, unless they would round across the gate (2.0001 on 4 CPUs is not "0.50 > 0.5").
  const two = perCore.toFixed(2);
  const shown = Number(two) <= HOST_GATE_LOAD_PER_CORE === pass ? two : perCore.toPrecision(6);
  const text =
    `load ${load1.toFixed(2)} on ${cpus} CPUs = ${shown} per core ` +
    `${pass ? "≤" : ">"} ${HOST_GATE_LOAD_PER_CORE} before the run`;
  return { load1, cpus, perCore, pass, measured: true, text };
}

/** What `lowerPriority` touches, so a test can run it without changing its own priority. */
export interface PrioritySys {
  /** This process's thread ids (Linux), or null where a process has one priority (macOS). */
  threads(): string[] | null;
  set(id: number, nice: number): void;
  get(id: number): number;
}

const TASKS = "/proc/self/task";

export const REAL_PRIORITY: PrioritySys = {
  threads: () => {
    try {
      return readdirSync(TASKS);
    } catch {
      return null;
    }
  },
  set: (id, nice) => setPriority(id, nice),
  get: (id) => getPriority(id),
};

/**
 * Lowers this process to `nice` (only ever lower: a process may not raise its own priority back
 * without privileges) and returns the niceness it ended at. On Linux a priority belongs to a
 * thread, so every thread the process has is reniced (V8's and libuv's included); threads and
 * child processes started afterwards inherit it, which is how headless Chromium and its renderer
 * get it. Elsewhere the process's own priority (`os.setPriority`). Call it after the server child
 * is spawned, so the server keeps its own. A thread that refuses is left as it is.
 */
export function lowerPriority(nice: number, sys: PrioritySys = REAL_PRIORITY): number {
  const threads = sys.threads();
  for (const id of threads ?? ["0"]) {
    const tid = Number(id);
    try {
      if (sys.get(tid) < nice) sys.set(tid, nice);
    } catch {
      // A thread that exited meanwhile, or a host that won't: the run reports what it got.
    }
  }
  return sys.get(0);
}

/** Each process's parent, from `/proc/<pid>/stat` (Linux), or null where `/proc` is missing. */
function parents(): Map<number, number> | null {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return null;
  }
  const out = new Map<number, number>();
  for (const p of pids) {
    try {
      const stat = readFileSync(`/proc/${p}/stat`, "utf8");
      const ppid = Number(
        stat
          .slice(stat.lastIndexOf(")") + 1)
          .trim()
          .split(/\s+/)[1],
      );
      out.set(Number(p), ppid);
    } catch {
      // Gone meanwhile.
    }
  }
  return out;
}

/**
 * The processes below `root` (its children, theirs, …), leaving out `exclude` and everything
 * below them, from a parent map.
 */
export function descendants(
  root: number,
  parentOf: ReadonlyMap<number, number>,
  exclude: ReadonlySet<number>,
): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of parentOf) {
    const list = children.get(ppid);
    if (list === undefined) children.set(ppid, [pid]);
    else list.push(pid);
  }
  const out: number[] = [];
  const todo = [...(children.get(root) ?? [])];
  while (todo.length > 0) {
    const pid = todo.pop() as number;
    if (exclude.has(pid)) continue;
    out.push(pid);
    todo.push(...(children.get(pid) ?? []));
  }
  return out;
}

/**
 * Holds this process's descendants (but `exclude`, the server child) at `nice` or below in
 * priority, returning how many threads it had to lower again. Chromium raises its own browser,
 * GPU and renderer threads (to nice −8 here) where it may, as root may; a process without that
 * privilege inherits 10 and keeps it, and this finds nothing to do. Linux only (elsewhere 0).
 */
export function holdNice(nice: number, exclude: ReadonlySet<number>): number {
  const parentOf = parents();
  if (parentOf === null) return 0;
  let lowered = 0;
  for (const pid of descendants(process.pid, parentOf, exclude)) {
    let tids: string[];
    try {
      tids = readdirSync(`/proc/${pid}/task`);
    } catch {
      continue;
    }
    for (const t of tids) {
      const tid = Number(t);
      try {
        if (getPriority(tid) < nice) {
          setPriority(tid, nice);
          lowered++;
        }
      } catch {
        // Exited meanwhile.
      }
    }
  }
  return lowered;
}

/**
 * The niceness of every thread of process `pid` (Linux, `/proc/<pid>/task/<tid>/stat` field 19),
 * or null where `/proc` is missing: what a test checks `lowerPriority` reached.
 */
export function threadNiceness(pid: number | "self" = "self"): number[] | null {
  try {
    return readdirSync(`/proc/${pid}/task`).map((tid) => {
      const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8");
      // The command name in parentheses may hold spaces: fields count from its closing one.
      const fields = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/);
      return Number(fields[16]);
    });
  } catch {
    return null;
  }
}

/**
 * The least favoured niceness among process `pid`'s threads (Linux), or null where `/proc` is
 * missing: what the summary records of the server child, which must stay above the generators.
 */
export function processNice(pid: number): number | null {
  const all = threadNiceness(pid);
  if (all === null || all.length === 0) return null;
  return Math.max(...all);
}

/** The 1-minute load average and the core count, as the host gate reads them. */
export interface HostLoad {
  /** Null on Windows, where `os.loadavg()` is always zeros (D-051). */
  readonly load1: number | null;
  readonly cpus: number;
}

export function hostLoad(platform: NodeJS.Platform = process.platform): HostLoad {
  return { load1: platform === "win32" ? null : (loadavg()[0] as number), cpus: cpus().length };
}
