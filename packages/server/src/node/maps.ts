import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Cmap, decodeCmap } from "@game/shared";

/** Map names the server loads: the greybox and compiled map ids (`snake_case`), no path parts. */
const MAP_NAME = /^[a-z0-9_]{1,63}$/;

/** The nearest `content/maps` at or above `dir`, or null. */
function findMapsDir(dir: string): string | null {
  let at = resolve(dir);
  for (;;) {
    const candidate = join(at, "content", "maps");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(at);
    if (parent === at) return null;
    at = parent;
  }
}

/**
 * The repository's `content/maps` (D-029): found above this module, which is
 * `packages/server/src/node` from source and `packages/server/dist` in the bundle, else above the
 * working directory (a bundle copied elsewhere and started from inside the repository). Null when
 * neither has one: the server then needs `--maps <dir>`.
 */
export function defaultMapsDir(cwd: string): string | null {
  return findMapsDir(dirname(fileURLToPath(import.meta.url))) ?? findMapsDir(cwd);
}

/** Loads and verifies `<dir>/<name>.cmap` (its content hash included). Throws with the path. */
export function loadMap(name: string, dir: string): Cmap {
  if (!MAP_NAME.test(name)) throw new Error(`map name "${name}" is not a map id`);
  const path = join(dir, `${name}.cmap`);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(path));
  } catch (e) {
    throw new Error(`map ${name}: cannot read ${path}: ${e instanceof Error ? e.message : e}`);
  }
  try {
    return decodeCmap(bytes);
  } catch (e) {
    throw new Error(`map ${name}: ${path}: ${e instanceof Error ? e.message : e}`);
  }
}
