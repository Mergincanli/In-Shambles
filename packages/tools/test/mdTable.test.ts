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
