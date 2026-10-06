import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { firstTable, mdSection } from "../../src/docs/mdTable";
import { fromRoot } from "../../src/paths";

// Every acceptance test ID a milestone lists in docs/09 must have a test whose top-level
// describe starts with it, or `vitest run -t "^MV-"` would pass with the test missing (M2 design
// §5, guards; risk "-t exits 0 when nothing matches"). An ID whose test lands in a later increment
// of the milestone waits in `pending`, which must be empty by the time docs/09 marks the
// milestone done. This guard's own describe must not start with an ID prefix.

interface Milestone {
  /** The IDs docs/09 lists under the milestone's **Acceptance**, in order. */
  readonly ids: readonly string[];
  /** IDs whose test is still to come; each must name its increment. */
  readonly pending: Readonly<Record<string, string>>;
}

const MILESTONES: Readonly<Record<string, Milestone>> = {
  M2: {
    ids: [
      "MV-01",
      "MV-03",
      "MV-04",
      "MV-05",
      "MV-06",
      "MV-07",
      "MV-08",
      "MV-17",
      "MV-18",
      "MV-19",
      "NET-03",
    ],
    pending: {},
  },
};

const roadmap = readFileSync(fromRoot("docs", "09-roadmap.md"), "utf8");

/**
 * IDs in an acceptance list, where one prefix covers a comma list ("MV-01, 03, 17 (basic), 19")
 * and parenthesised notes are skipped.
 */
function acceptanceIds(text: string): string[] {
  const out: string[] = [];
  const list = /\b(MV|NET|BAL)-(\d+(?:\s*\([^)]*\))?(?:\s*,\s*\d+(?:\s*\([^)]*\))?)*)/g;
  for (const m of text.matchAll(list)) {
    const numbers = (m[2] ?? "").replace(/\([^)]*\)/g, "").match(/\d+/g) ?? [];
    for (const n of numbers) out.push(`${m[1]}-${n}`);
  }
  return out;
}

function acceptanceText(milestone: string): string {
  const section = mdSection(roadmap, `${milestone} — `);
  const at = section.indexOf("**Acceptance**");
  if (at === -1) throw new Error(`docs/09 ${milestone} has no **Acceptance** list`);
  return section.slice(at);
}

function isDone(milestone: string): boolean {
  const status = firstTable(mdSection(roadmap, "Status"));
  const row = status.rows.find((cells) => cells[0] === milestone);
  if (row === undefined) throw new Error(`docs/09 status table has no ${milestone} row`);
  return (row[2] ?? "").includes("☑");
}

/**
 * Whether `source` has a top-level describe (or describe.each(...)) whose title starts with `id`:
 * at column 0, outside block comments, not skipped, and with the ID ending there ("MV-1" is not
 * "MV-19").
 */
function hasTopLevelDescribe(id: string, source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const top = new RegExp(`^describe(\\.each\\([^\\n]*\\))?\\(\\s*["'\`]${id}\\b`, "m");
  return top.test(code);
}

const testSources = readdirSync(fromRoot("packages"), { recursive: true, encoding: "utf8" })
  .filter((file) => !file.includes("node_modules") && /[\\/]test[\\/].*\.test\.ts$/.test(file))
  .map((file) => ({ file, source: readFileSync(join(fromRoot("packages"), file), "utf8") }));

function filesFor(id: string): string[] {
  return testSources.filter((t) => hasTopLevelDescribe(id, t.source)).map((t) => t.file);
}

describe.each(Object.entries(MILESTONES))("acceptance tests of %s", (milestone, m) => {
  it("match the IDs docs/09 lists", () => {
    expect(acceptanceIds(acceptanceText(milestone))).toEqual(m.ids);
  });

  it.each(m.ids.filter((id) => m.pending[id] === undefined).map((id) => [id]))(
    "%s has a test file named after it",
    (id) => {
      expect(filesFor(id)).not.toEqual([]);
    },
  );

  it.each(Object.keys(m.pending).map((id) => [id]))(
    "%s is still pending (drop it from the list once its test lands)",
    (id) => {
      expect(m.ids).toContain(id);
      expect(filesFor(id)).toEqual([]);
    },
  );

  it("leave nothing pending once docs/09 marks the milestone done", () => {
    expect(isDone(milestone) && Object.keys(m.pending).length > 0).toBe(false);
  });
});

describe("acceptance ID lists", () => {
  it("expand a shared prefix and skip notes", () => {
    expect(
      acceptanceIds("Movement tests MV-01, 03, 17 (basic), 19 pass. NET-03 (x, 4) passes"),
    ).toEqual(["MV-01", "MV-03", "MV-17", "MV-19", "NET-03"]);
  });

  it.each([
    ['describe("MV-05: crouch", () => {});', true],
    ["describe('MV-05: crouch', () => {});", true],
    ['describe.each([[1]])("MV-05: crouch at %i", () => {});', true],
    ['describe(\n  "MV-05: crouch",\n  () => {},\n);', true],
    ['describe("MV-05", () => {});', true],
    ['  describe("MV-05: nested", () => {});', false],
    ['describe.skip("MV-05: skipped", () => {});', false],
    ['/*\ndescribe("MV-05: commented out", () => {});\n*/', false],
    ['// describe("MV-05: line comment", () => {});', false],
    ['describe("MV-050: another ID", () => {});', false],
    ['describe("crouch MV-05", () => {});', false],
  ] as const)("count a top-level describe: %j → %s", (source, expected) => {
    expect(hasTopLevelDescribe("MV-05", source)).toBe(expected);
  });

  it('tell "MV-1" from "MV-19"', () => {
    expect(hasTopLevelDescribe("MV-1", 'describe("MV-19: determinism", () => {});')).toBe(false);
    expect(hasTopLevelDescribe("MV-19", 'describe("MV-19: determinism", () => {});')).toBe(true);
  });
});
