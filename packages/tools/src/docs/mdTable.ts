/**
 * Minimal Markdown helpers for golden tests that compare data files against the spec docs.
 * They throw instead of guessing, so a restructured doc fails a test loudly.
 */

export interface MdTable {
  headers: string[];
  rows: string[][];
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Text under the first heading starting with `headingPrefix`, up to the next heading of the same or a higher level. */
export function mdSection(markdown: string, headingPrefix: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => HEADING.exec(line)?.[2]?.startsWith(headingPrefix));
  if (start === -1) throw new Error(`heading "${headingPrefix}" not found`);
  const level = HEADING.exec(lines[start] ?? "")?.[1]?.length ?? 1;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const match = HEADING.exec(lines[i] ?? "");
    if (match?.[1] && match[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** Parse the first GitHub-style table in `markdown`. Cells are trimmed; formatting is kept. */
export function firstTable(markdown: string): MdTable {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(
    (line, i) => line.trimStart().startsWith("|") && SEPARATOR.test(lines[i + 1]?.trim() ?? ""),
  );
  if (start === -1) throw new Error("no table found");

  const headers = splitRow(lines[start] ?? "");
  const rows: string[][] = [];
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (!line.startsWith("|")) break;
    const cells = splitRow(line);
    if (cells.length !== headers.length) {
      throw new Error(
        `row ${rows.length + 1} has ${cells.length} cells, expected ${headers.length}`,
      );
    }
    rows.push(cells);
  }
  return { headers, rows };
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}
