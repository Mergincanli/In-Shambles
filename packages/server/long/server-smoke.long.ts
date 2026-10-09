import { describe, expect, it } from "vitest";
import {
  expectStartsAndStops,
  listening,
  POSIX,
  pnpm,
  READY,
  repoRoot,
  start,
  waitFor,
} from "../test/smokeRun";

// The server smoke test's long tier (D-032): the server from source stopped on SIGINT
// (`smoke.test.ts` stops it on SIGTERM in `pnpm test`), and the acceptance command itself,
// `pnpm dev:server` from the repo root, stopped with its process group. Real processes on real
// time.

describe("server smoke test", () => {
  it("starts, logs JSON lines, answers /status, and stops cleanly on SIGINT", async () => {
    await expectStartsAndStops("SIGINT");
  }, 15_000);

  // The acceptance command itself, run the way a terminal's Ctrl+C or a process manager stops it.
  it.skipIf(!POSIX)(
    "`pnpm dev:server` from the repo root starts the server and stops with its process group",
    async () => {
      const [command, args] = pnpm(["dev:server", "--port", "0"]);
      const run = start(command, args, repoRoot, true);
      await waitFor(run, READY, 20_000, true);
      // pnpm hands the flags on to the server: it took a free port, not the default 28700.
      expect(listening(run).port).not.toBe(28700);
      run.kill("SIGTERM");
      await waitFor(run, /"ev":"shutdown"/, 5_000, false);
    },
    30_000,
  );
});
