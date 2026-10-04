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

/**
 * Throws in dev builds when `condition` is falsy. In prod it's a no-op, so callers must still clamp.
 *
 * Hot paths run this every tick, so keep the success path allocation-free:
 * - `message` must be a string literal; never build it with a template at the call site.
 * - Pass a value worth seeing as `detail`; it's formatted only when the assert fails.
 * - Put expensive conditions behind `if (devAssertsEnabled())`, because prod still evaluates them.
 */
export function DEV_ASSERT(
  condition: unknown,
  message: string,
  detail?: number | string | boolean,
): asserts condition {
  if (enabled && !condition) {
    throw new DevAssertError(detail === undefined ? message : `${message} (got ${String(detail)})`);
  }
}
