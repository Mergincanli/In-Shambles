import { afterEach, describe, expect, it } from "vitest";
import { DEV_ASSERT, DevAssertError, devAssertsEnabled, setDevAsserts } from "../src/debug/assert";

describe("DEV_ASSERT", () => {
  afterEach(() => setDevAsserts(true));

  it("is enabled by default and passes on a truthy condition", () => {
    expect(devAssertsEnabled()).toBe(true);
    expect(() => DEV_ASSERT(1 + 1 === 2, "math")).not.toThrow();
  });

  it("throws a DevAssertError with the message on a falsy condition", () => {
    expect(() => DEV_ASSERT(false, "speed must be finite")).toThrow(DevAssertError);
    expect(() => DEV_ASSERT(0, "speed must be finite")).toThrow("speed must be finite");
  });

  it("appends the detail value only to the failure message", () => {
    expect(() => DEV_ASSERT(true, "speed must be finite", Number.NaN)).not.toThrow();
    expect(() => DEV_ASSERT(false, "speed must be finite", Number.NaN)).toThrow(
      "speed must be finite (got NaN)",
    );
  });

  it("is a no-op once disabled (prod builds clamp instead)", () => {
    setDevAsserts(false);
    expect(() => DEV_ASSERT(false, "ignored in prod")).not.toThrow();
  });

  it("narrows types", () => {
    const value: string | undefined = "ok";
    DEV_ASSERT(value !== undefined, "value is set");
    expect(value.length).toBe(2);
  });
});
