import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser, Page } from "playwright";
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
import { decodePng, distinctColors, type Png } from "../scripts/png";
import { expectHealthy, sample, VIEW, waitForMoving } from "./health";

// The e2e smoke test (M2 design §5): the real production build, served by `vite preview`, in
// headless Chromium with software WebGL. The page runs the server Worker and the client with the
// scripted strafe-jump circuit; the autotest status it writes into <html data-*> says the
// handshake finished, snapshots arrive, the prediction never needed a correction, and frames are
// drawn. Without WebGL the sim and network path are still checked (M2 plan, risk 7). Further cases
// drive the player's own keys and the click that takes the pointer lock.

const RUN_MS = 3000;
/** Where the console-and-HUD run saves its screenshot, when set (`E2E_SCREENSHOT_DIR`). */
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR;
/** The sky colour (src/render/renderer.ts) and how far a pixel may be from it to count as sky. */
const SKY = [0x9d, 0xb3, 0xc9] as const;
const SKY_TOLERANCE = 6;

/** Share of the pixels in rows [y0, y1) of `png` that are not the sky colour. */
function nonSkyShare(png: Png, y0: number, y1: number): number {
  let n = 0;
  let other = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = 0; x < png.width; x += 2) {
      const i = (y * png.width + x) * png.channels;
      const sky =
        Math.abs((png.data[i] ?? 0) - SKY[0]) <= SKY_TOLERANCE &&
        Math.abs((png.data[i + 1] ?? 0) - SKY[1]) <= SKY_TOLERANCE &&
        Math.abs((png.data[i + 2] ?? 0) - SKY[2]) <= SKY_TOLERANCE;
      n++;
      if (!sky) other++;
    }
  }
  return other / n;
}

/**
 * A player's page (no autotest) with requestPointerLock wrapped: the raw (`unadjustedMovement`)
 * request is refused as Firefox does (`reject`) or as an older engine might (`throw`), or passed
 * through (`none`). Every call is logged in `window.lockCalls`.
 */
async function openPlayerPage(
  browser: Browser,
  url: string,
  refuseRaw: string,
): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: VIEW });
  const errors = watchErrors(page);
  await page.addInitScript((refuse) => {
    const original = Element.prototype.requestPointerLock;
    const calls: string[] = [];
    (window as unknown as { lockCalls: string[] }).lockCalls = calls;
    Element.prototype.requestPointerLock = function (
      this: Element,
      options?: { unadjustedMovement?: boolean },
    ) {
      const raw = options?.unadjustedMovement === true;
      calls.push(raw ? "raw" : "plain");
      if (raw && refuse === "reject") {
        return Promise.reject(new DOMException("no raw input", "NotSupportedError"));
      }
      if (raw && refuse === "throw") throw new DOMException("no raw input", "NotSupportedError");
      return Reflect.apply(original, this, raw ? [options] : []);
    } as typeof original;
  }, refuseRaw);
  await page.goto(url);
  return { page, errors };
}

describe("client e2e smoke (M2 design §5)", () => {
  let dir = "";
  let served: Served | null = null;
  let browser: Browser | null = null;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "client-e2e-"));
    await buildClient(join(dir, "dist"));
    served = await servePreview(join(dir, "dist"));
    browser = await launchChromium();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await served?.close();
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  it("connects to the Worker server, predicts without corrections and draws", async () => {
    const page = await (browser as Browser).newPage({ viewport: VIEW });
    const errors = watchErrors(page);
    await page.goto(`${served?.url}?autotest=1&bot=circle`);
    await waitForRunning(page);
    await waitForMoving(page);
    const moving = await sample(page);
    await page.waitForTimeout(RUN_MS);
    const end = await sample(page);
    const s = end.s;
    // The canvas alone: the DOM label's antialiased text would add colours of its own.
    await page.addStyleTag({ content: "#label, #error { display: none !important; }" });
    const shot = decodePng(new Uint8Array(await page.locator("#view").screenshot()));
    await page.close();

    expect(errors).toEqual([]);
    expect(s.state).toBe("running");
    expect(Number(s.snapshots), JSON.stringify(s)).toBeGreaterThan(120);
    expect(Number(s.ticks), JSON.stringify(s)).toBeGreaterThan(120);
    expect(Number(s.frames), JSON.stringify(s)).toBeGreaterThan(30);
    expectHealthy(moving, end);
    // The circle bot ran: well over 1000 u in RUN_MS once moving (standing still reports 0).
    expect(Number(s.distance), JSON.stringify(s)).toBeGreaterThan(200);
    if (s.webgl !== "1") {
      // Only a failed WebGL 2 context lands here: GameRenderer.create lets other errors through.
      console.warn("e2e smoke: WebGL unavailable, checked the sim and network path only");
      return;
    }
    expect(Number(s.drawCalls)).toBeGreaterThan(0);
    expect(Number(s.triangles)).toBeGreaterThan(0);
    // Sky, floor, grid lines and walls: far more than one colour, on the canvas alone.
    expect(distinctColors(shot)).toBeGreaterThan(8);
    // The bot looks level, so the floor fills the lower half: the world is drawn, lit and aimed.
    expect(nonSkyShare(shot, shot.height >> 1, shot.height)).toBeGreaterThan(0.9);
  }, 60_000);

  it("moves the player from held keys, with no corrections", async () => {
    const page = await (browser as Browser).newPage({ viewport: VIEW });
    const errors = watchErrors(page);
    // No bot: the player's own input path (keyboard router, binds, sampler) builds the cmds.
    await page.goto(`${served?.url}?autotest=1`);
    await waitForRunning(page);
    // Past the start, whose shader compiles and first snapshots may starve a cmd or two.
    await page.waitForTimeout(2000);
    const before = await sample(page);
    expect(Number(before.s.distance), JSON.stringify(before.s)).toBe(0);
    await page.keyboard.down("KeyW");
    await page.waitForTimeout(2000);
    await page.keyboard.up("KeyW");
    // One status interval, so the last report includes the run.
    await page.waitForTimeout(400);
    const after = await sample(page);
    await page.close();

    expect(errors).toEqual([]);
    // Some 600 to 800 u forward in 2 s from a standing start.
    expect(Number(after.s.distance), JSON.stringify(after.s)).toBeGreaterThan(200);
    expectHealthy(before, after);
  }, 60_000);

  it.each(["none", "reject", "throw"])(
    "takes the pointer lock on a click, the raw request refused: %s",
    async (refuseRaw) => {
      const { page, errors } = await openPlayerPage(
        browser as Browser,
        served?.url ?? "",
        refuseRaw,
      );
      const prompt = page.locator("#hud-prompt");
      const crosshair = page.locator("#hud-crosshair");
      await expect.poll(() => prompt.isVisible(), { timeout: 15_000 }).toBe(true);
      expect(await crosshair.isVisible()).toBe(false);
      await page.mouse.click(VIEW.width / 2, VIEW.height / 2);
      await expect
        .poll(() => page.evaluate(() => document.pointerLockElement?.id ?? ""))
        .toBe("view");
      // A refused raw request falls back to plain pointer lock (docs/06 §7 "Input").
      const calls = await page.evaluate(
        () => (window as unknown as { lockCalls: string[] }).lockCalls,
      );
      // Headless Chromium refuses raw input itself, so a pass-through raw request may fall back.
      if (refuseRaw === "none") expect(calls[0]).toBe("raw");
      else expect(calls).toEqual(["raw", "plain"]);
      await expect.poll(() => prompt.isVisible()).toBe(false);
      expect(await crosshair.isVisible()).toBe(true);
      // Losing the lock (Escape, in a real browser) brings the prompt back.
      await page.evaluate(() => document.exitPointerLock());
      await expect.poll(() => prompt.isVisible()).toBe(true);
      expect(await crosshair.isVisible()).toBe(false);
      await page.close();
      expect(errors).toEqual([]);
    },
    60_000,
  );

  it("opens the console with Backquote, round-trips set pm_gravity and shows the HUD", async () => {
    const page = await (browser as Browser).newPage({ viewport: VIEW });
    const errors = watchErrors(page);
    await page.goto(`${served?.url}?autotest=1&bot=circle`);
    await waitForRunning(page);
    await waitForMoving(page);
    const moving = await sample(page);
    const consoleBox = page.locator("#console");
    const input = page.locator("#console-input");
    const output = page.locator("#console-output");
    await expect.poll(() => consoleBox.isVisible()).toBe(false);
    await page.keyboard.press("Backquote");
    await expect.poll(() => consoleBox.isVisible()).toBe(true);
    // The key that opened it typed nothing, and the input has the focus.
    expect(await input.inputValue()).toBe("");
    expect(await input.evaluate((el) => el === document.activeElement)).toBe(true);
    for (const line of [
      "set pm_gravity 400",
      "set cl_netgraph 1",
      "set cl_speedometer 1",
      "set r_stats 1",
    ]) {
      await input.fill(line);
      await input.press("Enter");
    }
    // The server's PRINT reply, then the client's mirror holding the new value.
    await expect.poll(() => output.textContent(), { timeout: 5000 }).toContain("pm_gravity = 400");
    // The mirror switches at the CVARS' effective tick, a little after the PRINT: ask again
    // until it does.
    await expect
      .poll(
        async () => {
          await input.fill("pm_gravity");
          await input.press("Enter");
          return output.locator("div").last().textContent();
        },
        { timeout: 5000 },
      )
      .toMatch(/^pm_gravity = 400 \(default 800, replicated/);
    const net = page.locator("#hud-net");
    const speed = page.locator("#hud-speed");
    await expect.poll(() => net.isVisible()).toBe(true);
    await expect.poll(() => net.textContent(), { timeout: 5000 }).toMatch(/rtt \d+ ms/);
    await expect.poll(() => speed.isVisible()).toBe(true);
    await expect.poll(() => speed.textContent(), { timeout: 5000 }).toMatch(/\d+ u\/s {2}vz/);
    // The renderer panel (r_stats) shows renderer.info whenever there is a picture.
    const render = page.locator("#hud-render");
    if ((await readStatus(page)).webgl === "1") {
      await expect.poll(() => render.isVisible()).toBe(true);
      await expect
        .poll(() => render.textContent(), { timeout: 5000 })
        .toMatch(/^render calls [1-9]\d* {2}tris [1-9]\d* {2}geo [1-9]\d* {2}tex [1-9]\d*$/);
    }
    await page.waitForTimeout(1500);
    const end = await sample(page);
    if (SHOT_DIR !== undefined && SHOT_DIR !== "") {
      const dir = resolve(SHOT_DIR);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "e2e_console_hud.png"), await page.screenshot());
    }
    // Backquote from the console's input closes it again.
    await input.press("Backquote");
    await expect.poll(() => consoleBox.isVisible()).toBe(false);
    // With the input's focus lost (a click on the view, Tab), Backquote and Escape still close
    // it, and a held Backquote's auto-repeat does not flip it.
    for (const close of ["Backquote", "Escape"]) {
      await page.keyboard.press("Backquote");
      await expect.poll(() => consoleBox.isVisible()).toBe(true);
      await input.press("Tab");
      // Below the console (the top 45 %) on the view.
      await page.mouse.click(VIEW.width / 2, VIEW.height - 10);
      expect(await input.evaluate((el) => el === document.activeElement)).toBe(false);
      await page.keyboard.press(close);
      await expect.poll(() => consoleBox.isVisible()).toBe(false);
    }
    await page.keyboard.down("Backquote");
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => {
        const init = { code: "Backquote", key: "`", repeat: true, bubbles: true, cancelable: true };
        (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", init));
      });
    }
    await page.keyboard.up("Backquote");
    expect(await consoleBox.isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => consoleBox.isVisible()).toBe(false);
    await page.close();

    expect(errors).toEqual([]);
    expect(end.s.state).toBe("running");
    // D-027: a live cvar change switches by tick, with no correction.
    expectHealthy(moving, end);
  }, 60_000);

  it("tells the player why the session closed and hides the click-to-play prompt", async () => {
    const page = await (browser as Browser).newPage({ viewport: VIEW });
    const errors = watchErrors(page);
    // The Worker server gets another build hash than the client's HELLO, so it kicks the client.
    await page.addInitScript(() => {
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
        const m = args[0] as { type?: string; buildHash?: string };
        if (m?.type === "start") m.buildHash = "other-build";
        return Reflect.apply(post, this, args);
      } as typeof post;
    });
    // A player's page (no autotest), so the prompt would show while the pointer is not locked.
    await page.goto(served?.url ?? "");
    const box = page.locator("#error");
    await expect.poll(() => box.isVisible(), { timeout: 10_000 }).toBe(true);
    expect(await box.textContent()).toMatch(/^disconnected: kicked: build .* other-build/);
    expect(await page.locator("#hud-prompt").isVisible()).toBe(false);
    expect(await page.locator("#hud-crosshair").isVisible()).toBe(false);
    await page.close();
    expect(errors.filter((e) => !e.includes("disconnected: kicked"))).toEqual([]);
  }, 60_000);
});
