import { configDefaults, defineConfig } from "vitest/config";
import { TestCostReporter } from "./scripts/test-cost-reporter.mjs";

/**
 * `pnpm test:long`, the long tier (D-032, M3 design §2.16): deterministic fake-clock long legs
 * and the allocation guards that run native-ESM child processes, blocking in CI like `pnpm test`.
 * Files are `*.long.ts` anywhere under `packages/<pkg>/long/`, a name the fast run's default
 * include never matches. `pnpm test:long -t "^NET-"` runs the long NET legs. Inline projects that
 * extend this root config, without the packages' own Vite configs: a long file must not import
 * client app code that needs `packages/client/vite.config.ts` (its `__BUILD_HASH__` define); one
 * that does needs a project of its own first.
 *
 * Two groups (D-032's amendment): every long file but the real-time ones with a host-speed gate
 * runs first, in parallel; then `REALTIME_LONG`, alone, so the CPU-bound sweeps never share the
 * host with a test that judges frame timing on the wall clock.
 */
export const LONG_GLOB = "packages/*/long/**/*.long.ts";
export const REALTIME_LONG: readonly string[] = ["packages/tools/long/server-stall.long.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "long",
          include: [LONG_GLOB],
          exclude: [...configDefaults.exclude, ...REALTIME_LONG],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "long-realtime",
          include: [...REALTIME_LONG],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
    reporters: ["default", new TestCostReporter({ label: "pnpm test:long", wallSeconds: 240 })],
  },
});
