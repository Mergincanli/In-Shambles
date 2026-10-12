import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { HOST_GATE_LOAD_PER_CORE } from "../src/bots/host";
import type { BotsSummary, SummaryCheck } from "../src/bots/summary";
import { fromRoot } from "../src/paths";

// The load tier's shared steps (D-045, M3 design §2.16): wait for the host to settle under the
// host gate, run `pnpm bots` as its own process, and read the summary it wrote. Every leg writes
// into `reports/load/<leg>/` (git-ignored), which CI's load job uploads.

export const LOAD_REPORTS = fromRoot("reports", "load");
const TOOLS_DIR = fromRoot("packages", "tools");
/** How long the host may take to settle before a leg (a 2-minute leg leaves about 2.5 behind). */
const SETTLE_TIMEOUT_MS = 180_000;
const SETTLE_POLL_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits until the 1-minute load average is under the host gate (0.5 per core), at most 3 min: the
 * leg before this one leaves its load in the average for a minute or two. A host still busy after
 * that is the leg's to fail, through the bots' own gate, with the numbers.
 */
export async function settleHost(log: (text: string) => void = console.log): Promise<number> {
  const until = performance.now() + SETTLE_TIMEOUT_MS;
  const n = cpus().length;
  for (;;) {
    const load = loadavg()[0] as number;
    if (load / n <= HOST_GATE_LOAD_PER_CORE || performance.now() >= until) {
      log(`load: host at ${load.toFixed(2)} on ${n} CPUs`);
      return load;
    }
    await sleep(SETTLE_POLL_MS);
  }
}

export interface BotsCliRun {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
  /** The summary the run wrote, or null (a refused run writes none). */
  readonly summary: BotsSummary | null;
  /** Its markdown, for failure messages. */
  readonly md: string;
}

/**
 * Runs `pnpm bots <args> --out reports/load/<leg>` as its own process (the CLI entry under tsx,
 * as `pnpm bots` runs it) and resolves with its exit code, output and summary.
 */
export function runBotsCli(args: readonly string[], leg: string): Promise<BotsCliRun> {
  const dir = join(LOAD_REPORTS, leg);
  mkdirSync(dir, { recursive: true });
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/bots/cli.ts", ...args, "--out", dir],
    { cwd: TOOLS_DIR, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => {
    out += String(c);
  });
  child.stderr.on("data", (c) => {
    err += String(c);
  });
  return new Promise((resolve) => {
    child.once("exit", (code) => {
      const wrote = /^bots: wrote (\S+\.json) and (\S+\.md)$/m.exec(out);
      const json = wrote?.[1];
      const md = wrote?.[2];
      resolve({
        code,
        out,
        err,
        summary:
          json !== undefined && existsSync(json)
            ? (JSON.parse(readFileSync(json, "utf8")) as BotsSummary)
            : null,
        md: md !== undefined && existsSync(md) ? readFileSync(md, "utf8") : `${out}\n${err}`,
      });
    });
  });
}

/** The summary of a run that wrote one (else a failure naming the run's output). */
export function summaryOf(run: BotsCliRun): BotsSummary {
  if (run.summary === null) {
    throw new Error(`the bots run wrote no summary (exit ${run.code}):\n${run.out}\n${run.err}`);
  }
  return run.summary;
}

/** A check of the summary by name (else a failure naming the ones it has). */
export function check(s: BotsSummary, name: string): SummaryCheck {
  const c = s.checks.find((x) => x.name === name);
  if (c === undefined) {
    throw new Error(`no check "${name}" in ${s.checks.map((x) => x.name).join(", ")}`);
  }
  return c;
}

/** A reported leg's numbers as `reports/load/<leg>/notes.md`. */
export function writeNotes(leg: string, text: string): string {
  const dir = join(LOAD_REPORTS, leg);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "notes.md");
  writeFileSync(file, `${text}\n`);
  return file;
}
