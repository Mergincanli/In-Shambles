import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { firstTable, mdSection } from "../../src/docs/mdTable";
import { fromRoot } from "../../src/paths";

// Every acceptance test ID a milestone lists in docs/09 must have a test whose top-level
// describe starts with it, or `vitest run -t "^MV-"` would pass with the test missing (M2 design
// §5, guards; risk "-t exits 0 when nothing matches"). An ID may also have a tier (D-032, M3
// design §2.16; from M3, and M2's MV-06 and MV-19 since D-032's amendment): its long legs
// (`pnpm test:long`, `packages/<pkg>/long/**/*.long.ts`) or
// real-time legs (`pnpm test:load`, `packages/tools/load/*.load.ts`) need a describe there too,
// besides the fast smoke in a `test/` file. A test that lands in a later increment of the
// milestone waits in `pending` ("<ID>" for the fast file, "<ID> long" or "<ID> load" for a tier),
// which must be empty by the time docs/09 marks the milestone done. This guard's own describe must
// not start with an ID prefix.

/** Where an ID's tests run besides `pnpm test` (M3 design §2.16). */
type Tier = "long" | "load";

interface Milestone {
  /** The IDs docs/09 lists under the milestone's **Acceptance**, in order. */
  readonly ids: readonly string[];
  /** IDs that also need a test in a tier's files. */
  readonly tiers?: Readonly<Record<string, Tier>>;
  /** Tests still to come, as "<ID>" or "<ID> <tier>"; each must name its increment. */
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
    // D-032 (amended at M3 increment 6): MV-06's full phase sweep runs in the long tier, a sample
    // of it in the fast one; MV-19's Vite library mode leg runs in the long tier, its in-process
    // repeat and esbuild leg in the fast one.
    tiers: { "MV-06": "long", "MV-19": "long" },
    pending: {},
  },
  M3: {
    ids: ["NET-01", "NET-02", "NET-04", "NET-05", "NET-07", "NET-08", "NET-09", "NET-10", "NET-12"],
    // §2.16 names NET-02, NET-04, NET-12 (long) and NET-09 (load); §5 and §6 increment 7 give
    // NET-05 long legs too (16 clients in increment 7, 64 players in increment 10). D-032's
    // amendment (increment 6) moved NET-01's full fuzz counts and NET-04's extra seeds,
    // browser-like and onset runs to the long tier, so both have long describes now.
    tiers: {
      "NET-01": "long",
      "NET-02": "long",
      "NET-04": "long",
      "NET-05": "long",
      "NET-12": "long",
      "NET-09": "load",
    },
    // NET-01's fast test covers the v2 full snapshots since increment 4 (deltas and the deferred
    // list extend it in increments 8 and 10); NET-04 keeps its M2 fast test until increment 9,
    // which adds its 16-client legs to its long file (`net-04-reconciliation.long.ts`, holding
    // the M2 runs the fast tier leaves out since D-032's amendment); NET-09's fast in-process
    // proxy landed in increment 6, its load leg comes in increment 18; NET-05's fast matrix and
    // its long file (the rest of the matrix, 16 clients) landed in increment 7, its 64-player leg
    // joins the long file in increment 10.
    pending: {
      "NET-02": "increment 8",
      "NET-02 long": "increment 9",
      "NET-07": "increment 11",
      "NET-08": "increment 9",
      "NET-09 load": "increment 18",
      "NET-10": "increment 13",
      "NET-12": "increment 9",
      "NET-12 long": "increment 9",
    },
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

/** Which tier a file under packages/ belongs to by its path, or null for none. */
function tierOf(file: string): "fast" | Tier | null {
  if (/[\\/]test[\\/].*\.test\.ts$/.test(file)) return "fast";
  if (/^[^\\/]+[\\/]long[\\/].*\.long\.ts$/.test(file)) return "long";
  if (/^tools[\\/]load[\\/][^\\/]+\.load\.ts$/.test(file)) return "load";
  return null;
}

const testSources = readdirSync(fromRoot("packages"), { recursive: true, encoding: "utf8" })
  .filter((file) => !file.includes("node_modules") && tierOf(file) !== null)
  .map((file) => ({
    file,
    tier: tierOf(file),
    source: readFileSync(join(fromRoot("packages"), file), "utf8"),
  }));

function filesFor(id: string, tier: "fast" | Tier = "fast"): string[] {
  return testSources
    .filter((t) => t.tier === tier && hasTopLevelDescribe(id, t.source))
    .map((t) => t.file);
}

/** Each test a milestone needs: "<ID>" (fast) and "<ID> <tier>", with the files that hold it. */
function requirements(m: Milestone): { key: string; files: () => string[] }[] {
  return m.ids.flatMap((id) => {
    const fast = { key: id, files: () => filesFor(id) };
    const tier = m.tiers?.[id];
    return tier === undefined
      ? [fast]
      : [fast, { key: `${id} ${tier}`, files: () => filesFor(id, tier) }];
  });
}

describe.each(Object.entries(MILESTONES))("acceptance tests of %s", (milestone, m) => {
  const needed = requirements(m);

  it("match the IDs docs/09 lists", () => {
    expect(acceptanceIds(acceptanceText(milestone))).toEqual(m.ids);
  });

  it("give tiers and pending entries only for listed IDs and known tiers", () => {
    for (const id of Object.keys(m.tiers ?? {})) expect(m.ids).toContain(id);
    const keys = needed.map((r) => r.key);
    for (const key of Object.keys(m.pending)) expect(keys).toContain(key);
  });

  it.each(needed.filter((r) => m.pending[r.key] === undefined).map((r) => [r.key, r]))(
    "%s has a test file named after it",
    (_key, r) => {
      expect(r.files()).not.toEqual([]);
    },
  );

  it.each(needed.filter((r) => m.pending[r.key] !== undefined).map((r) => [r.key, r]))(
    "%s is still pending (drop it from the list once its test lands)",
    (_key, r) => {
      expect(r.files()).toEqual([]);
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

  it.each([
    ["shared/test/net/codecs.test.ts", "fast"],
    ["tools/test/net/net-04-reconciliation.test.ts", "fast"],
    ["tools/long/net-04-sixteen-clients.long.ts", "long"],
    ["tools/long/mv-06-slopes.long.ts", "long"],
    ["shared/long/net-01-codec-fuzz.long.ts", "long"],
    ["client/long/perf/view-frame-allocation.long.ts", "long"],
    ["tools/load/net-09-server-perf.load.ts", "load"],
    ["tools/long/helpers.ts", null],
    ["tools/test/net/harness.ts", null],
    ["tools/long/net-04.test.ts", null],
    ["tools/test/net-04.long.ts", null],
    ["server/load/net-09.load.ts", null],
    ["tools/load/sub/net-09.load.ts", null],
  ] as const)("put %s in tier %s", (file, tier) => {
    expect(tierOf(file)).toBe(tier);
  });

  it('tell "MV-1" from "MV-19"', () => {
    expect(hasTopLevelDescribe("MV-1", 'describe("MV-19: determinism", () => {});')).toBe(false);
    expect(hasTopLevelDescribe("MV-19", 'describe("MV-19: determinism", () => {});')).toBe(true);
  });
});
