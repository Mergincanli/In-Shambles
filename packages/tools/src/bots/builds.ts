import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fromRoot } from "../paths";

/**
 * The production builds a bots run plays against (M3 design §2.15, D-045) and whether each is
 * newer than the code it is built from. A stale build would measure yesterday's code: a plain run
 * falls back to the server's source (serverChild.ts), a `--strict` run refuses it, and the human
 * stand-in always needs the client build (`vite preview` serves only a build).
 */

export interface Build {
  /** What the refusal calls it. */
  readonly name: string;
  /** The file whose modification time is the build's. */
  readonly output: string;
  /** Files and folders whose newest modification time the build must not be older than. */
  readonly sources: readonly string[];
}

/** The server bundle (`pnpm build`, `packages/server/build.mjs`). */
export const SERVER_BUILD: Build = {
  name: "server bundle packages/server/dist/main.js",
  output: fromRoot("packages", "server", "dist", "main.js"),
  sources: [
    fromRoot("packages", "server", "src"),
    fromRoot("packages", "shared", "src"),
    fromRoot("packages", "server", "build.mjs"),
    fromRoot("pnpm-lock.yaml"),
  ],
};

/**
 * The client build (`pnpm build`, Vite): the page and the Worker server it bundles (the match
 * code and `@game/server`'s entry, which the Worker and the console import), the shared sim, the
 * maps it ships and the dependency versions.
 */
export const CLIENT_BUILD: Build = {
  name: "client build packages/client/dist",
  output: fromRoot("packages", "client", "dist", "index.html"),
  sources: [
    fromRoot("packages", "client", "src"),
    fromRoot("packages", "client", "index.html"),
    fromRoot("packages", "client", "vite.config.ts"),
    fromRoot("packages", "shared", "src"),
    fromRoot("packages", "server", "src", "index.ts"),
    fromRoot("packages", "server", "src", "match"),
    fromRoot("content", "maps"),
    fromRoot("pnpm-lock.yaml"),
  ],
};

export type BuildState = "fresh" | "stale" | "missing";

/**
 * The newest modification time (ms) of a file, or of a folder and anything under it. A folder's
 * own time changes when an entry is added, removed or renamed, so a deleted source file makes the
 * build stale too.
 */
function newestMtime(path: string): number {
  const st = statSync(path);
  if (st.isFile()) return st.mtimeMs;
  let newest = st.mtimeMs;
  for (const entry of readdirSync(path, { recursive: true, encoding: "utf8" })) {
    newest = Math.max(newest, statSync(join(path, entry)).mtimeMs);
  }
  return newest;
}

/** Whether `b` is built, and no older than any of its sources. */
export function buildState(b: Build): BuildState {
  if (!existsSync(b.output)) return "missing";
  const built = statSync(b.output).mtimeMs;
  let sources = 0;
  for (const s of b.sources) sources = Math.max(sources, newestMtime(s));
  return built >= sources ? "fresh" : "stale";
}

/**
 * Why a run may not start on these builds, or null. `--strict` judges the code as it is, so it
 * refuses a server bundle (when it starts the server itself) or a client build (with `--human`)
 * that is missing or older than its sources; without it, only a missing client build stops a
 * `--human` run.
 */
export function buildRefusal(
  o: { readonly strict: boolean; readonly human: boolean; readonly ownServer: boolean },
  state: (b: Build) => BuildState = buildState,
): string | null {
  const why = (b: Build, s: BuildState) =>
    `${b.name} is ${s === "missing" ? "missing" : "older than its sources"}: run pnpm build first`;
  if (o.strict && o.ownServer) {
    const s = state(SERVER_BUILD);
    if (s !== "fresh") return `--strict: ${why(SERVER_BUILD, s)}`;
  }
  if (o.human) {
    const s = state(CLIENT_BUILD);
    if (s === "missing" || (o.strict && s === "stale")) {
      return `${o.strict ? "--strict" : "--human"}: ${why(CLIENT_BUILD, s)}`;
    }
  }
  return null;
}

/**
 * What a run that goes ahead on a stale build should say: without `--strict`, a `--human` page
 * older than its sources plays the old client, and the build hash cannot tell (a dirty tree's
 * hash is `<HEAD>-dirty` before and after an edit). Null when there is nothing to say.
 */
export function buildWarning(
  o: { readonly strict: boolean; readonly human: boolean },
  state: (b: Build) => BuildState = buildState,
): string | null {
  if (o.strict || !o.human || state(CLIENT_BUILD) !== "stale") return null;
  return `warning: ${CLIENT_BUILD.name} is older than its sources: the human plays the old client (pnpm build)`;
}
