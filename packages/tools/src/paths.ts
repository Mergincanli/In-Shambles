import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repo root (the folder containing pnpm-workspace.yaml). */
export function repoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`pnpm-workspace.yaml not found above ${from}`);
    dir = parent;
  }
  return dir;
}

/** Resolve a path relative to the repo root. */
export function fromRoot(...segments: string[]): string {
  return join(repoRoot(), ...segments);
}
