// The build hash every part of the game agrees on (M3 design §1 "Root", D-029): the Node server
// computes it here when it runs from source and its bundle has it baked in by build.mjs. HELLO
// carries it and a server refuses another build.
import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `BUILD_HASH` if set; else the short git hash of HEAD, with `-dirty` when the checkout has
 * uncommitted changes; else "dev" when this folder isn't a checkout of this repo (e.g. inside
 * some parent repo, or no git at all).
 */
export function computeBuildHash() {
  if (process.env.BUILD_HASH) return process.env.BUILD_HASH;
  const git = (args) =>
    execSync(`git ${args}`, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    // Only this repo's own checkout counts, not a parent repo (even a pnpm monorepo).
    if (realpathSync(git("rev-parse --show-toplevel")) !== realpathSync(repoRoot)) return "dev";
    const hash = git("rev-parse --short HEAD");
    return git("status --porcelain") === "" ? hash : `${hash}-dirty`;
  } catch {
    return "dev";
  }
}
