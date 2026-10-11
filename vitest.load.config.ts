import { configDefaults, defineConfig } from "vitest/config";

/**
 * `pnpm test:load`, the load tier (D-032, D-045, M3 design §2.16): real processes on real time,
 * `packages/tools/load/*.load.ts`, a name neither the fast nor the long run picks up. Each leg runs
 * `pnpm bots` (the CLI, as its own process: the bots lower their own priority to nice 10, which a
 * test worker must not) against the built server, after the host has settled under the host gate.
 * Two groups, one file at a time, so no leg shares the host with another: first the gated legs
 * (`GATED_LOAD`: NET-09 and the 16 bots + 1 human check), then the reported ones (one 63-bot match,
 * 4 matches × 16 bots), which record their numbers and fail only when they did not run. The groups
 * are 1 and 2, not 0 and 1: Vitest runs a one-at-a-time project of group 0 after every numbered
 * group. `pnpm build` first: a strict leg refuses a build older than its sources. CI runs it in its
 * own `load` job, which does not block (D-045).
 */
export const LOAD_GLOB = "packages/tools/load/*.load.ts";
export const GATED_LOAD: readonly string[] = [
  "packages/tools/load/net-09-server-perf.load.ts",
  "packages/tools/load/load-16-plus-1.load.ts",
];

/** A leg's own time plus the host's settling and the runs it may repeat. */
const LEG_TIMEOUT_MS = 15 * 60_000;

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "load",
          include: [...GATED_LOAD],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "load-reported",
          include: [LOAD_GLOB],
          exclude: [...configDefaults.exclude, ...GATED_LOAD],
          fileParallelism: false,
          sequence: { groupOrder: 2 },
        },
      },
    ],
    testTimeout: LEG_TIMEOUT_MS,
    hookTimeout: LEG_TIMEOUT_MS,
    // The legs' summaries carry the numbers; the default reporter prints each leg's log lines.
    silent: false,
  },
});
