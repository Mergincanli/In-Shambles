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

  it("keeps commas inside strings and accepts a BOM", () => {
    expect(parseJsonc('\uFEFF{ "a": "x, }", "b": ["c, ]",] }')).toEqual({ a: "x, }", b: ["c, ]"] });
    expect(parseJsonc('{ "a": 1, // last\n }')).toEqual({ a: 1 });
  });

  it("keeps comment-like text inside strings", () => {
    expect(parseJsonc('{ "url": "http://x/*y*/", "q": "say \\"//hi\\"" }')).toEqual({
      url: "http://x/*y*/",
      q: 'say "//hi"',
    });
  });
});
