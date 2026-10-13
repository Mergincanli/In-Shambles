// The build hash every part of the game agrees on (M3 design §1 "Root", D-029, D-031): the Node
// server computes it here when it runs from source, its bundle has it baked in by build.mjs, and
// the page's `__BUILD_HASH__` comes from here too (vite.config.ts; the build-hash guard checks
// that nothing computes it another way). HELLO carries it; a server with sv_strictBuild 1 refuses
// another build.
import { execFileSync } from "node:child_process";
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
  // git itself, no shell; `windowsHide` keeps a console window from flashing up on Windows when
  // the caller has none (the bots' detached server child; D-051).
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  try {
    // Only this repo's own checkout counts, not a parent repo (even a pnpm monorepo). The native
    // real paths, so the drive letter's and the folders' case, a subst drive or an 8.3 name on
    // Windows can't tell one folder from itself (git prints the path as stored on disk).
    const top = git("rev-parse", "--show-toplevel");
    if (realpathSync.native(top) !== realpathSync.native(repoRoot)) return "dev";
    const hash = git("rev-parse", "--short", "HEAD");
    return git("status", "--porcelain") === "" ? hash : `${hash}-dirty`;
  } catch {
    return "dev";
  }
}
