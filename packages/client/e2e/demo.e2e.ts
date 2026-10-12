import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Match, MemoryDemoSink } from "@game/server";
import {
  buildCollisionWorld,
  createLoopbackPair,
  decodeCmap,
  TEAM_1,
  TEAM_2,
  validateDemo,
} from "@game/shared";
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
import { ClientSim, type CmdSampler, createScriptedInput } from "../src/net";
import { teamColor } from "../src/render/teamColors";
import { VIEW } from "./health";

// The ?demo= smoke (D-044, M3 design §5 "Demo"): a demo recorded from a real match (3 scripted
// players on arena_greybox, server and clients in this process on a fake clock) is served beside
// the production client, which plays it at ?demo=: the camera follows the lowest id, and a
// BracketRight press (the default follownext bind) switches to the next, the HUD line in the
// team colour. A file that is not a demo, or one recorded on another map version, shows why.

const TICK_MS = 1000 / 60;

/** A hue as the browser reports an element's colour. */
function rgb(hex: number): string {
  return `rgb(${(hex >> 16) & 0xff}, ${(hex >> 8) & 0xff}, ${hex & 0xff})`;
}

/** 3 players' match on arena_greybox, recorded for `seconds` once all have joined. */
function recordMatch(seconds: number): Uint8Array {
  const path = fileURLToPath(new URL("../../../content/maps/arena_greybox.cmap", import.meta.url));
  const cmap = decodeCmap(new Uint8Array(readFileSync(path)));
  const world = buildCollisionWorld(cmap);
  const match = new Match({ cmap, world, buildHash: "demo-e2e", primer: false });
  let now = 0;
  const clients: ClientSim[] = [];
  for (const bot of ["circle", "mixed", "circle"]) {
    const [clientEnd, serverEnd] = createLoopbackPair();
    match.connect(serverEnd);
    const c = new ClientSim({
      transport: clientEnd,
      cmap,
      world,
      buildHash: "demo-e2e",
      clock: () => now,
      input: createScriptedInput(bot) as CmdSampler,
      primer: false,
    });
    c.connect();
    clients.push(c);
  }
  const step = () => {
    now += TICK_MS;
    match.tick();
    for (const c of clients) c.frame();
  };
  for (let i = 0; i < 120 && !clients.every((c) => c.active); i++) step();
  const sink = new MemoryDemoSink();
  match.startRecording(sink, "e2e");
  for (let i = 0; i < seconds * 60; i++) step();
  match.stopRecording();
  return sink.bytes();
}

describe("client e2e: demo playback with player cycling (D-044)", () => {
  let dir = "";
  let served: Served | null = null;
  let browser: Browser | null = null;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "client-demo-e2e-"));
    const bytes = recordMatch(20);
    const check = validateDemo(bytes);
    if (!check.ok) throw new Error(check.error);
    await buildClient(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "e2e.demo"), bytes);
    // Before the preview starts: it lists the build's files once.
    writeFileSync(join(dir, "dist", "bad.demo"), "ISDM not really");
    // Valid, but recorded on another version of the map: the hash's low byte differs.
    const other = bytes.slice();
    const hashAt = 13 + 1 + check.header.mapName.length;
    other[hashAt] = (other[hashAt] as number) ^ 1;
    expect(validateDemo(other).ok).toBe(true);
    writeFileSync(join(dir, "dist", "other-map.demo"), other);
    served = await servePreview(join(dir, "dist"));
    browser = await launchChromium();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await served?.close();
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  it("plays ?demo= behind the lowest id, and ] follows the next player", async () => {
    const page = await (browser as Browser).newPage({ viewport: VIEW });
    const errors = watchErrors(page);
    await page.goto(`${served?.url}?autotest=1&demo=e2e.demo`);
    await waitForRunning(page);
    await expect
      .poll(async () => (await readStatus(page)).following, { timeout: 10_000 })
      .toBe("0");
    const before = await readStatus(page);
    expect(before.demo).toBe("1");
    expect(before.map).toBe("arena_greybox");
    expect(before.remotes).toBe("3");
    const follow = page.locator("#hud-follow");
    expect(await follow.textContent()).toBe("following #0");
    // The line takes the followed player's team colour (#0 team 1, #1 team 2); no crosshair.
    expect(await follow.evaluate((el) => el.style.color)).toBe(rgb(teamColor(TEAM_1)));
    expect(await page.locator("#hud-crosshair").isHidden()).toBe(true);
    await page.keyboard.press("BracketRight");
    await expect.poll(async () => (await readStatus(page)).following, { timeout: 5000 }).toBe("1");
    expect(await follow.textContent()).toBe("following #1");
    expect(await follow.evaluate((el) => el.style.color)).toBe(rgb(teamColor(TEAM_2)));
    await page.keyboard.press("BracketLeft");
    await expect.poll(async () => (await readStatus(page)).following, { timeout: 5000 }).toBe("0");
    const end = await readStatus(page);
    expect(Number(end.demoTick)).toBeGreaterThan(Number(before.demoTick));
    expect(end.demoFaults).toBe("0");
    if (end.webgl === "1") expect(Number(end.capsules)).toBe(3);
    await page.close();
    expect(errors).toEqual([]);
  }, 60_000);

  it("refuses a file that is not a valid demo with the reason", async () => {
    const page = await (browser as Browser).newPage({ viewport: VIEW });
    await page.goto(`${served?.url}?autotest=1&demo=bad.demo`);
    await expect
      .poll(async () => (await readStatus(page)).error ?? "", { timeout: 10_000 })
      .toMatch(/^demo bad\.demo: /);
    await page.goto(`${served?.url}?autotest=1&demo=other-map.demo`);
    await expect
      .poll(async () => (await readStatus(page)).error ?? "", { timeout: 10_000 })
      .toMatch(
        /^demo other-map\.demo: recorded on map arena_greybox version [0-9a-f]{16}, this client has [0-9a-f]{16}$/,
      );
    await page.close();
  }, 30_000);
});
