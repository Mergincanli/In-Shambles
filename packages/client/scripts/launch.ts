import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { build, createServer, preview } from "vite";

/**
 * Builds, serves and opens the real client from Node (M2 design §5 "e2e smoke"): the production
 * build, `vite preview` of it (or the dev server) and headless Chromium. No DOM types here, so the
 * tools' Node code can drive a page too (`pnpm bots --human`, D-045); what runs inside the page
 * stays in browser.ts.
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
