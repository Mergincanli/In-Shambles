import { describe, expect, it } from "vitest";
import { bootLabel } from "../src/bootLabel";

describe("bootLabel", () => {
  it("shows the placeholder text with the build hash", () => {
    expect(bootLabel("abc1234")).toBe("client ok · build abc1234");
  });
});
