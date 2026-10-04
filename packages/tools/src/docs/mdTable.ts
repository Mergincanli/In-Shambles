/**
 * Minimal Markdown helpers for golden tests that compare data files against the spec docs.
 * They throw instead of guessing, so a restructured doc fails a test loudly.
 */

export interface MdTable {
  headers: string[];
  rows: string[][];
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SEPARATOR = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
const PIPE = /(?<!\\)\|/;

/**
 * Text under the one heading that starts with `headingPrefix`, up to the next heading of the
 * same or a higher level. Throws if no heading or more than one heading matches.
 */
export function mdSection(markdown: string, headingPrefix: string): string {
  const lines = markdown.split(/\r?\n/);
  const fenced = fencedLines(lines);
  const headings = lines.map((line, i) => (fenced[i] ? null : HEADING.exec(line)));
  const matches = headings.flatMap((match, i) =>
    match?.[2]?.startsWith(headingPrefix) ? [i] : [],
  );
  if (matches.length === 0) throw new Error(`heading "${headingPrefix}" not found`);
  if (matches.length > 1) {
    throw new Error(`${matches.length} headings match "${headingPrefix}"; make the prefix unique`);
  }

  const start = matches[0] as number;
  const level = headings[start]?.[1]?.length ?? 1;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const match = headings[i];
    if (match?.[1] && match[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

/**
 * Parse the first GitHub-style table outside fenced code blocks. Cells are trimmed;
 * formatting and escaped pipes are kept. The table ends at a blank line or a line without
 * a pipe; a row with the wrong number of cells throws.
 */
export function firstTable(markdown: string): MdTable {
  const lines = markdown.split(/\r?\n/);
  const fenced = fencedLines(lines);
  const start = lines.findIndex(
    (line, i) =>
      !fenced[i] &&
      !fenced[i + 1] &&
      PIPE.test(line) &&
      SEPARATOR.test(lines[i + 1]?.trim() ?? "") &&
      splitRow(lines[i + 1] ?? "").length === splitRow(line).length,
  );
  if (start === -1) throw new Error("no table found");

  const headers = splitRow(lines[start] ?? "");
  const rows: string[][] = [];
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (fenced[i] || line === "" || !PIPE.test(line)) break;
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

/** True for every line inside a fenced code block, fence lines included. */
function fencedLines(lines: string[]): boolean[] {
  const fenced: boolean[] = [];
  let open = "";
  for (const line of lines) {
    const fence = FENCE.exec(line)?.[1] ?? "";
    if (open) {
      fenced.push(true);
      // A closing fence uses the same character and is at least as long.
      if (fence && fence[0] === open[0] && fence.length >= open.length) open = "";
    } else {
      fenced.push(fence !== "");
      open = fence;
    }
  }
  return fenced;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(PIPE)
    .map((cell) => cell.trim());
}
