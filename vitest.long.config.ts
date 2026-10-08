import { defineConfig } from "vitest/config";
import { TestCostReporter } from "./scripts/test-cost-reporter.mjs";

/**
 * `pnpm test:long`, the long tier (D-032, M3 design §2.16): deterministic fake-clock long legs
 * and the allocation guards that run native-ESM child processes, blocking in CI like `pnpm test`.
 * Files are `*.long.ts` anywhere under `packages/<pkg>/long/`, a name the fast run's default
 * include never matches. `pnpm test:long -t "^NET-"` runs the long NET legs. One root project,
 * without the packages' own Vite configs: a long file must not import client app code that needs
 * `packages/client/vite.config.ts` (its `__BUILD_HASH__` define); one that does needs a project
 * entry here first.
 */
export const LONG_GLOB = "packages/*/long/**/*.long.ts";

export default defineConfig({
  test: {
    include: [LONG_GLOB],
    reporters: ["default", new TestCostReporter({ label: "pnpm test:long", wallSeconds: 240 })],
  },
});
