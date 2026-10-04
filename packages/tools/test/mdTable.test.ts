import { describe, expect, it } from "vitest";
import { firstTable, mdSection } from "../src/docs/mdTable";

const DOC = `# Title

## 1. Intro
Text.

## 2. Table section
Some text.

| ID | A | B |
|---|---|---|
| \`one\` | 1 | 2 |
| two (note) |  3 | 4  |

### 2.1 Subsection
More.

## 3. Next
| X | Y |
|---|---|
| 9 | 9 |
`;

describe("mdSection", () => {
  it("returns the section up to the next heading of the same level, including subsections", () => {
    const section = mdSection(DOC, "2. Table section");
    expect(section).toContain("| `one` | 1 | 2 |");
    expect(section).toContain("### 2.1 Subsection");
    expect(section).not.toContain("## 3. Next");
  });

  it("throws when the heading is missing", () => {
    expect(() => mdSection(DOC, "9. Missing")).toThrow(/heading "9. Missing" not found/);
  });
});

describe("firstTable", () => {
  it("parses headers and trimmed rows of the first table", () => {
    const table = firstTable(mdSection(DOC, "2. Table section"));
    expect(table.headers).toEqual(["ID", "A", "B"]);
    expect(table.rows).toEqual([
      ["`one`", "1", "2"],
      ["two (note)", "3", "4"],
    ]);
  });

  it("throws when there is no table", () => {
    expect(() => firstTable(mdSection(DOC, "1. Intro"))).toThrow(/no table/);
  });

  it("throws on a row with the wrong number of cells", () => {
    const ragged = "| A | B |\n|---|---|\n| 1 |\n";
    expect(() => firstTable(ragged)).toThrow(/row 1 has 1 cells, expected 2/);
  });
});

describe("mdSection edge cases", () => {
  it("ignores # lines inside fenced code blocks", () => {
    const doc =
      "## 1. Real\n```sh\n# not a heading\n## 2. Fake\n```\n| A |\n|---|\n| 1 |\n## 2. Next\n";
    const section = mdSection(doc, "1. Real");
    expect(section).toContain("| 1 |");
    expect(section).not.toContain("## 2. Next");
    expect(() => mdSection("```\n## 3. Hidden\n```\n", "3. Hidden")).toThrow(/not found/);
  });

  it("throws when several headings match the prefix", () => {
    const doc = "## 4. Damage table notes\ntext\n## 4. Damage table (FACT)\n| A |\n|---|\n| 1 |\n";
    expect(() => mdSection(doc, "4. Damage table")).toThrow(/2 headings match "4. Damage table"/);
  });
});

describe("firstTable edge cases", () => {
  it("skips a pipe line that has no separator after it", () => {
    const table = firstTable("| prose with a pipe |\n\n| H |\n|---|\n| 1 |\n");
    expect(table.headers).toEqual(["H"]);
    expect(firstTable.bind(null, "| a |\n| b |\n")).toThrow(/no table/);
  });

  it("accepts alignment colons and one-dash separators", () => {
    expect(firstTable("| A | B |\n|:---|-:|\n| 1 | 2 |\n").rows).toEqual([["1", "2"]]);
  });

  it("keeps rows without a leading pipe instead of silently stopping", () => {
    const table = firstTable("| A | B |\n|---|---|\n| 1 | 2 |\n3 | 4 |\n| 5 | 6 |\n");
    expect(table.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
    ]);
  });

  it("returns only the first of two tables", () => {
    const table = firstTable("| A |\n|---|\n| 1 |\n\n| B |\n|---|\n| 2 |\n");
    expect(table).toEqual({ headers: ["A"], rows: [["1"]] });
  });

  it("keeps escaped pipes inside cells, including at the end", () => {
    const table = firstTable("| A | B |\n|---|---|\n| x \\| y | z \\|\n");
    expect(table.rows).toEqual([["x \\| y", "z \\|"]]);
  });

  it("ignores tables inside fenced code blocks", () => {
    const table = firstTable("```\n| X |\n|---|\n| 0 |\n```\n| A |\n|---|\n| 1 |\n");
    expect(table.headers).toEqual(["A"]);
  });
});
