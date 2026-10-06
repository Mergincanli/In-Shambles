import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// D-022: the shared determinism and trace vectors, replayed unchanged in real browser engines.
// `pnpm test` (the Node run) never loads this file. WebKit runs JavaScriptCore, Safari's engine.
export const ENGINES = ["chromium", "firefox", "webkit"] as const;
export type Engine = (typeof ENGINES)[number];

export const VECTORS_GLOB = "packages/shared/test/*-vectors.test.ts";

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
// them via PLAYWRIGHT_BROWSERS_PATH. CHROMIUM_PATH points at another Chromium if the builds drift.
const chromiumPath = process.env.CHROMIUM_PATH;

export default defineConfig({
  test: {
    include: [VECTORS_GLOB],
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      instances: parseBrowsers(process.env.BROWSERS).map((browser) => ({
        browser,
        provider: playwright(
          browser === "chromium" && chromiumPath !== undefined && chromiumPath !== ""
            ? { launchOptions: { executablePath: chromiumPath } }
            : {},
        ),
      })),
    },
  },
});
