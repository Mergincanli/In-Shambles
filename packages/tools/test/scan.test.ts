import { describe, expect, it } from "vitest";
import { scanSource } from "../src/code/scan";

describe("scanSource", () => {
  it("drops comments and blanks string contents", () => {
    const { code, strings } = scanSource(
      `const a = "x // y"; // Date.now()\n/* Math.random */ b('z');`,
    );
    expect(code).toBe(`const a = ""; \n  b('');`);
    expect(strings).toEqual(["x // y", "z"]);
  });

  it("keeps template expressions as code and their text as strings", () => {
    const { code, strings } = scanSource("t(`http://a ${Math.random()} b`);");
    expect(code).toBe("t(`${Math.random()}`);");
    expect(strings).toEqual(["http://a ", " b"]);
  });

  it("handles nested templates and braces inside expressions", () => {
    const { code, strings } = scanSource("x = `a ${ { k: `in ${y}` }.k } c`; z();");
    expect(code).toBe("x = `${ { k: `${y}` }.k }`; z();");
    expect(strings).toEqual(["a ", "in ", "", " c"]);
  });

  it("skips regex literals, including ones with // in them", () => {
    const { code } = scanSource("const re = /https?:\\/\\//g; const t = Date.now();");
    expect(code).toBe("const re = / /; const t = Date.now();");
  });

  it("treats a / after a value as division", () => {
    expect(scanSource("const r = a / b / c;").code).toBe("const r = a / b / c;");
  });
});
