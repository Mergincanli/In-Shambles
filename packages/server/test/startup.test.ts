import { describe, expect, it } from "vitest";
import { startupLine } from "../src/startup";

describe("startupLine", () => {
  it("logs server ok with the monotonic timestamp", () => {
    expect(startupLine(12.3456)).toBe("server ok t=12.346ms");
  });
});
