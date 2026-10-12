import { defineConfig } from "vitest/config";
import { TestCostReporter } from "./scripts/test-cost-reporter.mjs";

// `pnpm test`, the fast tier (D-032): every `*.test.ts` under a package. The long tier
// (`*.long.ts`, vitest.long.config.ts) and the browser projects (vitest.browser.config.ts) have
// their own configs, so this run never loads them.
export default defineConfig({
  test: {
    projects: ["packages/*"],
    reporters: [
      "default",
      new TestCostReporter({ label: "pnpm test", wallSeconds: 55, cpuSeconds: 165 }),
    ],
  },
});
