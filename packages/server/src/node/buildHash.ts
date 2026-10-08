import { computeBuildHash } from "../../../../scripts/build-hash.mjs";

/** Defined by build.mjs in the bundle; undeclared when the server runs from source (tsx). */
declare const __BUILD_HASH__: string | undefined;

/** Whether this is the production bundle (build.mjs baked the hash in), not a run from source. */
export function isBundledServer(): boolean {
  return typeof __BUILD_HASH__ === "string";
}

/**
 * This server's build hash (D-029): baked into the bundle when it was built, else computed from
 * the checkout by the same script (`scripts/build-hash.mjs`). HELLO must carry it.
 */
export function serverBuildHash(): string {
  return typeof __BUILD_HASH__ === "string" ? __BUILD_HASH__ : computeBuildHash();
}
