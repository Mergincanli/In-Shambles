import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const configDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Short git hash for the page: `BUILD_HASH` if set, `<hash>-dirty` with uncommitted changes,
 * and "dev" when this folder isn't a checkout of this repo (e.g. inside some parent repo).
 */
function buildHash(): string {
  if (process.env.BUILD_HASH) return process.env.BUILD_HASH;
  const git = (args: string) =>
    execSync(`git ${args}`, {
      cwd: configDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    if (!existsSync(join(git("rev-parse --show-toplevel"), "pnpm-workspace.yaml"))) return "dev";
    const hash = git("rev-parse --short HEAD");
    return git("status --porcelain") === "" ? hash : `${hash}-dirty`;
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
