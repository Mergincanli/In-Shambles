import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { computeBuildHash } from "../../../scripts/build-hash.mjs";
import { TestClient } from "./match/fixtures";
import { NodeWsClient, until } from "./node/wsClient";
import {
  events,
  expectStartsAndStops,
  listening,
  POSIX,
  READY,
  serverDir,
  start,
  waitFor,
  within,
} from "./smokeRun";

// The server smoke test: the server from source started, queried and stopped on
// SIGTERM, refusing a bad setting, and the production bundle run with plain node. Tiers (D-032):
// the SIGINT stop and `pnpm dev:server` from the repo root are the long tier's
// (`packages/server/long/server-smoke.long.ts`); the process helpers are shared (`smokeRun.ts`).

describe("server smoke test", () => {
  it("starts, logs JSON lines, answers /status, and stops cleanly on SIGTERM", async () => {
    await expectStartsAndStops("SIGTERM");
  }, 15_000);

  it("exits 1 with an error line on a bad setting", async () => {
    const run = start(
      process.execPath,
      ["--import", "tsx", "src/node/main.ts", "--port", "0", "--set", "sv_nope=1"],
      serverDir,
    );
    const exit = await within(run.exited, 10_000, "no exit on a bad setting");
    expect(exit).toEqual({ code: 1, signal: null });
    expect(events(run.output(), "error")[0]?.msg).toBe("--set: unknown cvar sv_nope");
  }, 15_000);

  it("the production bundle runs with plain node and serves a WebSocket client", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "server-bundle-"));
    onTestFinished(() => rmSync(outDir, { recursive: true, force: true, maxRetries: 5 }));
    // Run the bundle under the same module type as packages/server/dist/main.js, outside the
    // workspace, so it can't lean on node_modules: ws must be inside it.
    const { type } = JSON.parse(readFileSync(join(serverDir, "package.json"), "utf8"));
    writeFileSync(join(outDir, "package.json"), JSON.stringify({ type }));
    const outfile = join(outDir, "main.js");
    const build = spawnSync(process.execPath, ["build.mjs", outfile], {
      cwd: serverDir,
      encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);
    // ws's MIT notice travels with the bundle (content/LICENSES.md).
    expect(readFileSync(join(outDir, "third-party-licenses.md"), "utf8")).toContain("## ws (MIT)");

    const metricsFile = join(outDir, "metrics.json");
    const run = start(
      process.execPath,
      [outfile, "--port", "0", "--metrics-out", metricsFile],
      serverDir,
    );
    await waitFor(run, READY, 10_000, true);
    const { port, buildHash } = listening(run);
    // The hash of the checkout it was built from, baked in: run from a temp dir, the bundle could
    // not compute it.
    expect(buildHash).toBe(computeBuildHash());
    const ws = await NodeWsClient.connect(`ws://127.0.0.1:${port}/`);
    onTestFinished(() => ws.ws.close());
    const client = new TestClient(ws);
    client.hello(buildHash);
    await until(() => {
      client.poll();
      return client.welcomes.length === 1;
    }, "WELCOME");
    expect(client.welcomes[0]?.mapName).toBe("arena_greybox");
    // The bundle is strict about builds (sv_strictBuild 1, D-031): another one is KICKed with both.
    const stranger = await NodeWsClient.connect(`ws://127.0.0.1:${port}/`);
    onTestFinished(() => stranger.ws.close());
    const other = new TestClient(stranger);
    other.hello("someone-else");
    await until(() => {
      other.poll();
      return other.closed !== null;
    }, "the other build's kick");
    expect(other.kicks.map((k) => k.reason)).toEqual([
      `build someone-else does not match the server's ${buildHash}`,
    ]);

    run.kill("SIGTERM");
    const exit = await within(run.exited, 5_000, "no exit after SIGTERM");
    if (POSIX) {
      expect(exit).toEqual({ code: 0, signal: null });
      expect(events(run.output(), "shutdown")).toHaveLength(1);
      await until(() => {
        client.poll();
        return client.closed !== null;
      }, "the client's close");
      expect(client.kicks.map((k) => k.reason)).toEqual(["server shutting down"]);
      // The run windows, written on the way out (D-029).
      const metrics = JSON.parse(readFileSync(metricsFile, "utf8"));
      expect(metrics).toMatchObject({ buildHash, matches: { main: { map: "arena_greybox" } } });
      expect(metrics.process.passes).toBeGreaterThan(0);
    }
  }, 30_000);
});
