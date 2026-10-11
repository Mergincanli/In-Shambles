import type { Page } from "playwright";

/**
 * Launches the real client in headless Chromium (M2 design §5 "e2e smoke"): builds it, serves it
 * with `vite preview` (or the dev server), opens a page and reads the autotest status the page
 * writes into `document.documentElement.dataset` (src/app/game.ts). The e2e smoke test and the
 * screenshot script both use it; the launching half is launch.ts.
 */

export {
  buildClient,
  CLIENT_DIR,
  launchChromium,
  type Served,
  SWIFTSHADER_ARGS,
  serveDev,
  servePreview,
} from "./launch";

/** Console errors and uncaught page errors, collected from the moment the page opens. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`page: ${e.message}`));
  return errors;
}

/** The page's autotest status (`<html data-*>`). */
export function readStatus(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    const d = document.documentElement.dataset;
    for (const key of Object.keys(d)) out[key] = d[key] ?? "";
    return out;
  });
}

/** Waits until the page reports `data-state=running` (throws on `error` or after `timeoutMs`). */
export async function waitForRunning(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const s = document.documentElement.dataset.state;
      if (s === "error") throw new Error(document.documentElement.dataset.error ?? "error");
      return s === "running";
    },
    undefined,
    { timeout: timeoutMs, polling: 100 },
  );
}
