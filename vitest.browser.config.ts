import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// `pnpm test:browser` (the Node run, `pnpm test`, never loads this file) runs two projects:
// - vectors (D-022): the shared determinism, trace and pmove vectors, replayed unchanged in real
//   browser engines. WebKit runs JavaScriptCore, Safari's engine.
// - e2e (M2 design §5): the built client in headless Chromium, driven from Node by Playwright.
//   It runs whenever chromium is among the engines.
export const ENGINES = ["chromium", "firefox", "webkit"] as const;
export type Engine = (typeof ENGINES)[number];

export const VECTORS_GLOB = "packages/shared/test/*-vectors.test.ts";
export const E2E_GLOB = "packages/client/e2e/*.e2e.ts";

const isEngine = (name: string): name is Engine => (ENGINES as readonly string[]).includes(name);

/** The engines `BROWSERS` asks for (default chromium); unknown, missing or repeated names throw. */
export function parseBrowsers(list: string | undefined): Engine[] {
  const requested = (list ?? "chromium")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const engines = requested.filter(isEngine);
  if (
    requested.length === 0 ||
    engines.length !== requested.length ||
    new Set(engines).size !== engines.length
  ) {
    throw new Error(`BROWSERS must list distinct names from ${ENGINES.join(", ")}; got "${list}"`);
  }
  return engines;
}

// playwright is pinned to the release whose browser builds match the installed ones, so it finds
// them via PLAYWRIGHT_BROWSERS_PATH. CHROMIUM_PATH points at another Chromium if the builds drift
// (the e2e project's launcher, packages/client/scripts/browser.ts, reads it too).
const chromiumPath = process.env.CHROMIUM_PATH;
const engines = parseBrowsers(process.env.BROWSERS);

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "vectors",
          include: [VECTORS_GLOB],
          browser: {
            enabled: true,
            headless: true,
            screenshotFailures: false,
            instances: engines.map((browser) => ({
              browser,
              provider: playwright(
                browser === "chromium" && chromiumPath !== undefined && chromiumPath !== ""
                  ? { launchOptions: { executablePath: chromiumPath } }
                  : {},
              ),
            })),
          },
        },
      },
      ...(engines.includes("chromium")
        ? [
            {
              test: {
                name: "e2e",
                include: [E2E_GLOB],
                environment: "node",
                testTimeout: 60_000,
                hookTimeout: 120_000,
              },
            },
          ]
        : []),
    ],
  },
});
