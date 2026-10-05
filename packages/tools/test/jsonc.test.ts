import { describe, expect, it } from "vitest";
import { parseJsonc } from "../src/jsonc";

describe("parseJsonc", () => {
  it("drops line, trailing and block comments and trailing commas", () => {
    const text = `{
      // a comment
      "a": 1, // trailing comment
      /* block */ "b": [true, false,],
    }`;
    expect(parseJsonc(text)).toEqual({ a: 1, b: [true, false] });
  });

  it("keeps comment-like text inside strings", () => {
    expect(parseJsonc('{ "url": "http://x/*y*/", "q": "say \\"//hi\\"" }')).toEqual({
      url: "http://x/*y*/",
      q: 'say "//hi"',
    });
  });
});
