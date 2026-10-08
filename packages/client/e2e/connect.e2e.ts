import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildClient,
  launchChromium,
  readStatus,
  type Served,
  servePreview,
  waitForRunning,
  watchErrors,
} from "../scripts/browser";
import { expectHealthy, sample, VIEW, waitForMoving } from "./health";

// The connect e2e (M3 design §5, D-031): the production server bundle as a child process (strict
// about builds, sv_strictBuild 1) and the production client built from the same checkout, in
// headless Chromium at `?connect=ws://…`. The page opens a WebSocket, loads the map the server's
// WELCOME names (arena_greybox, not the Worker's movement_lab), and plays the circle bot with the
// e2e prediction-health rule.

const RUN_MS = 3000;
const serverDir = fileURLToPath(new URL("../../server", import.meta.url));

interface ServerChild {
  readonly child: ChildProcess;
  readonly port: number;
  readonly buildHash: string;
  output(): string;
}

/** Starts the bundle on a free port and resolves with the port its `listening` line names. */
function startServer(bundle: string): Promise<ServerChild> {
  // From packages/server, so the bundle (built outside the repository) finds content/maps.
  const child = spawn(process.execPath, [bundle, "--port", "0"], { cwd: serverDir });
  let output = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line:\n${output}`)), 15_000);
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      const line = output.split("\n").find((l) => l.includes('"ev":"listening"'));
      if (line === undefined) return;
      clearTimeout(timer);
      const l = JSON.parse(line) as { port: number; buildHash: string };
      resolve({ child, port: l.port, buildHash: l.buildHash, output: () => output });
    });
    child.once("exit", (code) => reject(new Error(`server exited (${code}):\n${output}`)));
  });
}

describe("client e2e: connect to a Node server (D-031)", () => {
  let dir = "";
  let served: Served | null = null;
  let browser: Browser | null = null;
  let server: ServerChild | null = null;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "client-connect-e2e-"));
    // The bundle runs outside the workspace (as in the server's smoke test), so it can't lean on
    // node_modules.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    const bundle = join(dir, "server", "main.js");
    const build = spawnSync(process.execPath, ["build.mjs", bundle], {
      cwd: serverDir,
      encoding: "utf8",
    });
    if (build.status !== 0) throw new Error(`server build failed:\n${build.stderr}`);
    writeFileSync(join(dir, "server", "package.json"), JSON.stringify({ type: "module" }));
    server = await startServer(bundle);
    await buildClient(join(dir, "dist"));
    served = await servePreview(join(dir, "dist"));
    browser = await launchChromium();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await served?.close();
    server?.child.kill("SIGTERM");
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  it("joins at ?connect=, loads the server's map, predicts without corrections and draws", async () => {
    const s0 = server as ServerChild;
    const page = await (browser as Browser).newPage({ viewport: VIEW });
    const errors = watchErrors(page);
    await page.goto(`${served?.url}?autotest=1&bot=circle&connect=ws://127.0.0.1:${s0.port}`);
    await waitForRunning(page);
    await waitForMoving(page);
    const moving = await sample(page);
    await page.waitForTimeout(RUN_MS);
    const end = await sample(page);
    const status = await (await fetch(`http://127.0.0.1:${s0.port}/status`)).json();
    await page.close();

    expect(errors).toEqual([]);
    const s = end.s;
    // The bundle is strict about builds: joining at all means the page's hash is the server's.
    expect(status).toMatchObject({ buildHash: s0.buildHash, matches: [{ players: 1 }] });
    expect(s.map).toBe("arena_greybox");
    expect(s.state).toBe("running");
    expect(Number(s.snapshots), JSON.stringify(s)).toBeGreaterThan(120);
    expect(Number(s.distance), JSON.stringify(s)).toBeGreaterThan(200);
    expectHealthy(moving, end, { webSocket: true });
    if (s.webgl === "1") expect(Number(s.drawCalls)).toBeGreaterThan(0);
  }, 60_000);

  it("starts at ?net_profile=, stays healthy on it, and leaves with the console's disconnect", async () => {
    const s0 = server as ServerChild;
    const page = await (browser as Browser).newPage({ viewport: VIEW });
    const errors = watchErrors(page);
    await page.goto(
      `${served?.url}?autotest=1&bot=circle&connect=ws://127.0.0.1:${s0.port}&net_profile=wan-100-loss1`,
    );
    await waitForRunning(page);
    await waitForMoving(page);
    const moving = await sample(page);
    await page.waitForTimeout(2000);
    const end = await sample(page);
    expect(end.s.netProfile).toBe("wan-100-loss1");
    expect(end.s.map).toBe("arena_greybox");
    expectHealthy(moving, end, { webSocket: true });

    await page.keyboard.press("Backquote");
    const input = page.locator("#console-input");
    await input.fill("disconnect");
    await input.press("Enter");
    await expect
      .poll(async () => (await readStatus(page)).error, { timeout: 5000 })
      .toBe("disconnected: left the server");
    // The server saw the close: the slot is free again.
    await expect
      .poll(
        async () => {
          const st = (await (await fetch(`http://127.0.0.1:${s0.port}/status`)).json()) as {
            matches: { players: number }[];
          };
          return st.matches[0]?.players;
        },
        { timeout: 5000 },
      )
      .toBe(0);
    await input.fill("connect");
    await input.press("Enter");
    await expect
      .poll(() => page.locator("#console-output div").last().textContent())
      .toBe(`not connected (last: ws://127.0.0.1:${s0.port}/)`);
    await page.close();
    expect(errors.filter((e) => !/left the server/.test(e))).toEqual([]);
  }, 60_000);

  it("says why when the server is not there", async () => {
    const page = await (browser as Browser).newPage({ viewport: VIEW });
    const errors = watchErrors(page);
    // A port nothing listens on: the socket fails and the session closes with a reason.
    await page.goto(`${served?.url}?autotest=1&connect=ws://127.0.0.1:1`);
    await expect
      .poll(async () => (await readStatus(page)).state, { timeout: 15_000 })
      .toBe("error");
    expect((await readStatus(page)).error).toBe("disconnected: could not connect to the server");
    await page.close();
    // The page logs its error, and Chromium the refused socket.
    expect(errors.filter((e) => !/could not connect|WebSocket connection/.test(e))).toEqual([]);
  }, 60_000);
});
