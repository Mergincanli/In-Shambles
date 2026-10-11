import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fromRoot } from "../src/paths";

// The bots' priority on a real process (D-045, M3 design §2.15): `lowerPriority` renices every
// thread of the process it runs in (V8's and libuv's too), and a child it starts afterwards
// inherits the niceness, as headless Chromium does. A child process of its own, so the test
// process keeps its priority. Linux only (`/proc`); the fake-process units are `pnpm test`'s
// (`packages/tools/test/bots/command.test.ts`).

const SCRIPT = `
import { spawnSync } from "node:child_process";
import { lowerPriority, threadNiceness } from "./src/bots/host.ts";
const before = threadNiceness();
const reached = lowerPriority(10);
const after = threadNiceness();
const child = spawnSync("sh", ["-c", "cut -d' ' -f19 /proc/self/stat"], { encoding: "utf8" });
console.log(JSON.stringify({ before, reached, after, child: Number(child.stdout.trim()) }));
`;

describe.runIf(process.platform === "linux")("the bots' priority", () => {
  it("lowers every thread of its process to nice 10, and its children inherit it", () => {
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", SCRIPT],
      {
        cwd: fromRoot("packages", "tools"),
        encoding: "utf8",
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const r = JSON.parse(run.stdout.trim()) as {
      before: number[];
      reached: number;
      after: number[];
      child: number;
    };
    expect(r.before.length).toBeGreaterThan(1);
    // It only ever lowers: under a shell already past 10 (`nice -n 15 pnpm test:long`) it keeps
    // that niceness.
    const want = Math.max(10, ...r.before);
    expect(r.reached).toBe(want);
    expect(r.after.length).toBeGreaterThanOrEqual(r.before.length);
    for (const n of r.after) expect(n).toBe(want);
    expect(r.child).toBe(want);
  }, 30_000);
});
