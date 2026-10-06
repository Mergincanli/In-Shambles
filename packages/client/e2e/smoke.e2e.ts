import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { decodePng, distinctColors, type Png } from "../scripts/png";

// The e2e smoke test (M2 design §5): the real production build, served by `vite preview`, in
// headless Chromium with software WebGL. The page runs the server Worker and the client with the
// scripted strafe-jump circuit; the autotest status it writes into <html data-*> says the
// handshake finished, snapshots arrive, the prediction never needed a correction, and frames are
// drawn. Without WebGL the sim and network path are still checked (M2 plan, risk 7).

const RUN_MS = 3000;
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
    const page = await (browser as Browser).newPage({ viewport: { width: 640, height: 360 } });
    const errors = watchErrors(page);
    await page.goto(`${served?.url}?autotest=1&bot=circle`);
    await waitForRunning(page);
    await page.waitForTimeout(RUN_MS);
    const s = await readStatus(page);
    // The canvas alone: the DOM label's antialiased text would add colours of its own.
    await page.addStyleTag({ content: "#label, #error { display: none !important; }" });
    const shot = decodePng(new Uint8Array(await page.locator("#view").screenshot()));
    await page.close();

    expect(errors).toEqual([]);
    expect(s.state).toBe("running");
    expect(Number(s.snapshots), JSON.stringify(s)).toBeGreaterThan(120);
    expect(Number(s.ticks), JSON.stringify(s)).toBeGreaterThan(120);
    expect(Number(s.corrections), JSON.stringify(s)).toBe(0);
    expect(Number(s.frames), JSON.stringify(s)).toBeGreaterThan(30);
    // The circle bot ran: some 400 u after its 1.5 s idle start (standing still reports 0).
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
});
