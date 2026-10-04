import { execSync } from "node:child_process";
import { defineConfig } from "vite";

/** Short git hash of the build, or "dev" outside a git checkout. */
function buildHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  define: {
    __BUILD_HASH__: JSON.stringify(buildHash()),
  },
  server: {
    port: 5173,
  },
});
