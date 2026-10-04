/**
 * Dev-build assertions (docs/06 §10). The shared sim never throws in normal operation:
 * invalid states are asserted in dev builds and clamped in prod. Hosts turn asserts off
 * for production builds with `setDevAsserts(false)`; a runtime flag keeps `shared` free of
 * environment APIs.
 */

let enabled = true;

export class DevAssertError extends Error {
  override name = "DevAssertError";
}

export function setDevAsserts(on: boolean): void {
  enabled = on;
}

export function devAssertsEnabled(): boolean {
  return enabled;
}

/** Throws in dev builds when `condition` is falsy. In prod it's a no-op, so callers must still clamp. */
export function DEV_ASSERT(condition: unknown, message: string): asserts condition {
  if (enabled && !condition) throw new DevAssertError(message);
}
