import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { build, createServer, preview } from "vite";

/**
 * Launches the real client in headless Chromium (M2 design §5 "e2e smoke"): builds it, serves it
 * with `vite preview` (or the dev server), opens a page and reads the autotest status the page
 * writes into `document.documentElement.dataset` (src/app/game.ts). The e2e smoke test and the
 * screenshot script both use it.
 */

export const CLIENT_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Software WebGL, so headless runs without a GPU still draw (M2 plan, risk 7). */
export const SWIFTSHADER_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

/**
 * Chromium from the installed Playwright browsers (PLAYWRIGHT_BROWSERS_PATH), or the binary at
 * CHROMIUM_PATH when the builds drift (D-022). Never downloads one.
 */
export function launchChromium(): Promise<Browser> {
  const executablePath = process.env.CHROMIUM_PATH;
  return chromium.launch({
    headless: true,
    args: SWIFTSHADER_ARGS,
    ...(executablePath !== undefined && executablePath !== "" ? { executablePath } : {}),
  });
}

export interface Served {
  readonly url: string;
  close(): Promise<void>;
}

/** A production build of the client into `outDir`. */
export async function buildClient(outDir: string): Promise<void> {
  await build({
    root: CLIENT_DIR,
    logLevel: "warn",
    build: { outDir, emptyOutDir: true },
  });
}

function urlOf(address: AddressInfo | string | null | undefined): string {
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error(`server has no TCP address (${String(address)})`);
  }
  return `http://127.0.0.1:${address.port}/`;
}

/** `vite preview` of a build in `outDir`, on a free port. */
export async function servePreview(outDir: string): Promise<Served> {
  const server = await preview({
    root: CLIENT_DIR,
    logLevel: "warn",
    build: { outDir },
    preview: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
  });
  return {
    url: urlOf(server.httpServer.address()),
    close: () => server.close(),
  };
}

/** The Vite dev server, on a free port. */
export async function serveDev(): Promise<Served> {
  const server = await createServer({
    root: CLIENT_DIR,
    logLevel: "warn",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
  });
  await server.listen();
  return {
    url: urlOf(server.httpServer?.address()),
    close: () => server.close(),
  };
}

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
