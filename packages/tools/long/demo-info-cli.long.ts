import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromRoot } from "../src/paths";
import { demoInfoFixture } from "../test/replay/fixture";

// The `pnpm demo-info` entry as its process (D-044), the long tier's real-process smoke (D-032):
// `node --import tsx src/replay/cli.ts` from packages/tools, as pnpm runs it, a relative path
// resolved against INIT_CWD (the directory the command was typed in), exit 0 with the text, and
// exit 1 with the reason for a corrupt file. The output itself is golden in
// packages/tools/test/replay/demo.test.ts.

describe("pnpm demo-info entry", () => {
  it("prints a demo from where the command was typed, and exits 1 on a corrupt one", () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-info-cli-"));
    try {
      const bytes = demoInfoFixture().bytes;
      writeFileSync(join(dir, "ok.demo"), bytes);
      writeFileSync(join(dir, "cut.demo"), bytes.subarray(0, 200));
      const run = (...args: string[]) =>
        spawnSync(process.execPath, ["--import", "tsx", "src/replay/cli.ts", ...args], {
          cwd: fromRoot("packages", "tools"),
          env: { ...process.env, INIT_CWD: dir },
          encoding: "utf8",
        });
      const ok = run("ok.demo");
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toMatch(/^demo ok\.demo\n/);
      expect(ok.stdout).toContain("records: 1300 SNAPSHOT, 24 EVENTS, 2 CVARS, 1 END");
      const json = run("ok.demo", "--json");
      expect(json.status).toBe(0);
      expect(JSON.parse(json.stdout).duration).toEqual({ ticks: 1300, seconds: 21.667 });
      const cut = run("cut.demo");
      expect(cut.status).toBe(1);
      expect(cut.stdout).toBe("");
      expect(cut.stderr).toMatch(/^demo-info: cut\.demo is not a valid demo: /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
