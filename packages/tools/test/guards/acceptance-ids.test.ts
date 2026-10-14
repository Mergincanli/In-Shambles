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
// which must be empty by the time docs/09 marks the milestone done. A pending test an earlier
// milestone already requires (M4's MV-01, re-targeted in M4 increment 3) keeps its file while it
// waits; any other pending test has none yet (D-064). This guard's own describe must not start
// with an ID prefix.

/** Where an ID's tests run besides `pnpm test` (M3 design §2.16). */
type Tier = "long" | "load";

interface Milestone {
  /** The IDs docs/09 lists under the milestone's **Acceptance**, in order. */
  readonly ids: readonly string[];
  /** IDs that also need a test in a tier's files. */
  readonly tiers?: Readonly<Record<string, Tier>>;
  /**
   * Tests still to come or still to change, as "<ID>" or "<ID> <tier>"; each names the increment
   * it waits for.
   */
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
    // browser-like and onset runs to the long tier, so both have long describes now. D-032's
    // placement rule put NET-08's 60 s window in the long tier in increment 9 (17 clients for
    // 60 s cost some 5 CPU-s of a fast run, which measures 5 s).
    tiers: {
      "NET-01": "long",
      "NET-02": "long",
      "NET-04": "long",
      "NET-05": "long",
      "NET-07": "long",
      "NET-08": "long",
      "NET-10": "long",
      "NET-12": "long",
      "NET-09": "load",
    },
    // NET-01's fast test covers the v2 full snapshots since increment 4, the deltas since increment
    // 8 and the deferred list since increment 10; NET-02's fast unit (the codec and the store's
    // rules over a long impaired world sequence) landed in increment 8, its match legs (fast smoke,
    // long file) in increment 9, as did NET-08 (a) and NET-12 (fast and long), and increment 10
    // added its scheduled sequences (fast, `packages/server/test/match/scheduler.test.ts`) and the
    // 64-player legs (`net-02-sixty-four-players.long.ts`); NET-04 keeps its M2 fast test, and
    // increment 9 added its 16-client legs to its long file (`net-04-reconciliation.long.ts`,
    // holding the M2 runs the fast tier leaves out since D-032's amendment); NET-09's fast
    // in-process proxy landed in increment 6, its load leg
    // (`packages/tools/load/net-09-server-perf.load.ts`, D-045) in increment 18; NET-05's fast
    // matrix and its long file (the rest of the matrix, 16 clients) landed in increment 7, its
    // 64-player legs (with a late joiner) joined the long file in increment 10, as did NET-08's
    // 32-player report (b), fast and long. NET-07 landed in increment 11: seed 1 at 144 Hz and the
    // control fast, the other seeds, the hitch frames and the rest of the control long (D-032's
    // placement rule). NET-10 landed in increment 13: the fake-clock attackers (a), the hidden-tab
    // cases and a real-socket smoke fast, the real-socket legs (b) long; its rcon lockout leg
    // joined the long file with rcon in increment 14, and its 404/503/1001 legs come with several
    // matches (increment 17). The M3 review added its flood legs (D-048): refused half-open
    // upgrades, a frame flood and descriptor exhaustion, `net-10-floods.long.ts` (its own top-level
    // NET-10 describe, so the guard holds both long files).
    pending: {},
  },
  // docs/09 lists "MV-01…MV-20" and "NET-03/04" (D-064); the tiers are the M4 design §5 table's
  // "Lg" legs, plus MV-06's long sweep, which M2 already requires (D-032). Every test starts M4 pending: a new one until its file lands, an M2 or M3 one (which
  // keeps its file) until the last increment it names. Increment 17 (the feel sign-off) empties
  // what is left and marks docs/09 done (M4 design §6).
  M4: {
    ids: [
      "MV-01",
      "MV-02",
      "MV-03",
      "MV-04",
      "MV-05",
      "MV-06",
      "MV-07",
      "MV-08",
      "MV-09",
      "MV-10",
      "MV-11",
      "MV-12",
      "MV-13",
      "MV-14",
      "MV-15",
      "MV-16",
      "MV-17",
      "MV-18",
      "MV-19",
      "MV-20",
      "NET-03",
      "NET-04",
    ],
    tiers: {
      "MV-06": "long",
      "MV-09": "long",
      "MV-11": "long",
      "MV-12": "long",
      "MV-13": "long",
      "MV-15": "long",
      "MV-18": "long",
      "MV-19": "long",
      "MV-20": "long",
      "NET-03": "long",
      "NET-04": "long",
    },
    pending: {
      "MV-01": "increment 3 re-targets it to the active parameters (D-052)",
      "MV-02": "increment 6 (sprint)",
      "MV-03": "increment 3 re-targets it",
      "MV-04": "increment 3 re-targets it and adds the jump-onto",
      "MV-05": "increment 3 re-targets it; increment 7 adds the jump-onto's health",
      "MV-06": "increment 3 re-targets it",
      "MV-06 long": "increment 3 re-targets its sweep",
      "MV-07": "increment 3 re-targets it",
      "MV-08": "increment 3 re-targets it",
      "MV-09": "increment 6 (the circle-jump smoke)",
      "MV-09 long": "increment 6 (the full circle-jump run)",
      "MV-10": "increment 8 (walls); increment 12 adds the players",
      "MV-11": "increment 8 (wall jumps); increment 10 adds the kick-then-grab",
      "MV-11 long": "increment 8 (the chimney phase sweep)",
      "MV-12": "increment 9 (power slide)",
      "MV-12 long": "increment 9 (the entry-speed sweep)",
      "MV-13": "increment 10 (ledge grab)",
      "MV-13 long": "increment 10 (the tick-phase sweep)",
      "MV-14": "increment 6 (stamina); increment 7 adds health",
      "MV-15": "increment 7 (fall damage)",
      "MV-15 long": "increment 7 (the drop sweep)",
      "MV-16": "increment 12 (goomba and boot)",
      "MV-17": "increment 3 re-targets it; increment 11 completes water",
      "MV-18": "increment 3 re-targets it; increment 11 completes ladders",
      "MV-18 long": "increment 11 (the top-mount phase sweep)",
      "MV-19": "increment 6 adds sprint; increment 15 the M4 yard and a second player",
      "MV-19 long": "increment 15 extends it",
      "MV-20": "increment 14 (the recorder and the restart from the wire)",
      "MV-20 long": "increment 14 (the 3-minute tour)",
      "NET-03": "increment 3 adds the preset switch; increments 6–11 the mechanics tour",
      "NET-03 long": "increment 6 (the mechanics tour's long leg)",
      "NET-04": "increment 4 adds solid players; increments 6–12 the tour legs",
      "NET-04 long": "increment 4 adds the solid-player legs; increments 6–12 the tour legs",
    },
  },
};

const roadmap = readFileSync(fromRoot("docs", "09-roadmap.md"), "utf8");

/** One number of an ID list, with a range ("01…20", "01…MV-20") or slashes ("03/04") after it. */
const ID_ITEM = String.raw`\d+(?:\s*(?:…|\.\.\.|–|/)\s*(?:(?:MV|NET|BAL)-)?\d+)*(?:\s*\([^)]*\))?`;
const ID_LIST = new RegExp(String.raw`\b(MV|NET|BAL)-(${ID_ITEM}(?:\s*,\s*${ID_ITEM})*)`, "g");

/** A range or a slash right after a list ends at a parenthesised note ("MV-01 (basic)…03"). */
const AFTER_NOTE = /^\s*(?:…|\.\.\.|–|\/)\s*(?:[A-Z]+-)?\d/;

/**
 * IDs in an acceptance list, where one prefix covers a comma list ("MV-01, 03, 17 (basic), 19"),
 * a range ("MV-01…MV-20", also with "..." or an en dash, the end's prefix optional) or a slash
 * list ("NET-03/04"), and parenthesised notes are skipped. The numbers of a range or a slash list
 * take its first number's width ("NET-03/4" is NET-03 and NET-04). Throws on a range or a slash
 * list that runs backwards, an end with another prefix, or a range or slash after a note, so a
 * typo in docs/09 fails loudly instead of listing the wrong IDs.
 */
function acceptanceIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ID_LIST)) {
    const prefix = m[1] ?? "";
    if (AFTER_NOTE.test(text.slice((m.index ?? 0) + m[0].length))) {
      throw new Error(`"${m[0]}": a range or slash after a parenthesised note`);
    }
    for (const item of (m[2] ?? "").replace(/\([^)]*\)/g, "").split(",")) {
      const tokens = item.match(/…|\.\.\.|–|\/|(?:[A-Z]+-)?\d+/g) ?? [];
      const first = tokens[0] ?? "";
      let last = Number(first);
      out.push(`${prefix}-${first}`);
      for (let k = 1; k + 1 < tokens.length; k += 2) {
        const sep = tokens[k] as string;
        const end = tokens[k + 1] as string;
        const dash = end.lastIndexOf("-");
        if (dash >= 0 && end.slice(0, dash) !== prefix) {
          throw new Error(`"${m[0]}": ${end} does not continue the ${prefix} list`);
        }
        const digits = end.slice(dash + 1);
        const n = Number(digits);
        if (n <= last) {
          const what = sep === "/" ? "the slash list goes on with" : "the range ends at";
          throw new Error(`"${m[0]}": ${what} ${digits}, not after ${last}`);
        }
        for (let i = sep === "/" ? n : last + 1; i <= n; i++)
          out.push(`${prefix}-${String(i).padStart(first.length, "0")}`);
        last = n;
      }
    }
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

/** The test keys the milestones before `milestone` (in MILESTONES order) already require. */
function earlierKeys(milestone: string): Set<string> {
  const keys = new Set<string>();
  for (const [name, m] of Object.entries(MILESTONES)) {
    if (name === milestone) break;
    for (const r of requirements(m)) keys.add(r.key);
  }
  return keys;
}

describe.each(Object.entries(MILESTONES))("acceptance tests of %s", (milestone, m) => {
  const needed = requirements(m);
  const earlier = earlierKeys(milestone);
  const pending = needed.filter((r) => m.pending[r.key] !== undefined);

  it("match the IDs docs/09 lists", () => {
    expect(acceptanceIds(acceptanceText(milestone))).toEqual(m.ids);
  });

  it("give tiers and pending entries only for listed IDs and known tiers", () => {
    for (const id of Object.keys(m.tiers ?? {})) expect(m.ids).toContain(id);
    const keys = needed.map((r) => r.key);
    for (const key of Object.keys(m.pending)) expect(keys).toContain(key);
  });

  it("name the increment each pending test waits for", () => {
    for (const [key, why] of Object.entries(m.pending))
      expect(why, key).toMatch(/\bincrements? \d/);
  });

  it.each(needed.filter((r) => m.pending[r.key] === undefined).map((r) => [r.key, r]))(
    "%s has a test file named after it",
    (_key, r) => {
      expect(r.files()).not.toEqual([]);
    },
  );

  it.each(pending.filter((r) => !earlier.has(r.key)).map((r) => [r.key, r]))(
    "%s is still pending (drop it from the list once its test lands)",
    (_key, r) => {
      expect(r.files()).toEqual([]);
    },
  );

  it.each(pending.filter((r) => earlier.has(r.key)).map((r) => [r.key, r]))(
    "%s keeps an earlier milestone's test while its change is pending",
    (_key, r) => {
      expect(r.files()).not.toEqual([]);
    },
  );

  it("leave nothing pending once docs/09 marks the milestone done", () => {
    expect(isDone(milestone) && Object.keys(m.pending).length > 0).toBe(false);
  });
});

describe("acceptance legs that live in more than one file", () => {
  // NET-10 (b)'s abuse legs and its flood legs (D-048; real time, so a file of their own in the
  // long tier's real-time group): losing either file must fail here, not pass on the other.
  it("keeps both of NET-10's long files", () => {
    expect(filesFor("NET-10", "long").sort()).toEqual([
      join("tools", "long", "net-10-abuse.long.ts"),
      join("tools", "long", "net-10-floods.long.ts"),
    ]);
  });
});

describe("acceptance ID lists", () => {
  it("expand a shared prefix and skip notes", () => {
    expect(
      acceptanceIds("Movement tests MV-01, 03, 17 (basic), 19 pass. NET-03 (x, 4) passes"),
    ).toEqual(["MV-01", "MV-03", "MV-17", "MV-19", "NET-03"]);
  });

  it.each([
    [
      "MV-01…MV-20 pass",
      Array.from({ length: 20 }, (_, i) => `MV-${String(i + 1).padStart(2, "0")}`),
    ],
    ["BAL-01…BAL-03 pass. NET-06 (lag comp) passes", ["BAL-01", "BAL-02", "BAL-03", "NET-06"]],
    ["MV-08...10 and MV-18 – 19", ["MV-08", "MV-09", "MV-10", "MV-18", "MV-19"]],
    ["MV-01, 03–05, 17 (basic)", ["MV-01", "MV-03", "MV-04", "MV-05", "MV-17"]],
    ["NET-03/04 still pass", ["NET-03", "NET-04"]],
    ["MV-10 / 11, NET-01/NET-02/05", ["MV-10", "MV-11", "NET-01", "NET-02", "NET-05"]],
    ["MV-9…11", ["MV-9", "MV-10", "MV-11"]],
    ["MV-8…10", ["MV-8", "MV-9", "MV-10"]],
    ["MV-01…9", ["MV-01", "MV-02", "MV-03", "MV-04", "MV-05", "MV-06", "MV-07", "MV-08", "MV-09"]],
    ["NET-03/4", ["NET-03", "NET-04"]],
    ["NET-03/05…07", ["NET-03", "NET-05", "NET-06", "NET-07"]],
    ["MV-01…03…05", ["MV-01", "MV-02", "MV-03", "MV-04", "MV-05"]],
  ] as const)("expand ranges and slashes: %j", (text, ids) => {
    expect(acceptanceIds(text)).toEqual(ids);
  });

  it.each([
    ["MV-05…MV-03", /ends at 03, not after 5/],
    ["MV-05…05", /ends at 05, not after 5/],
    ["MV-01…NET-20", /NET-20 does not continue the MV list/],
    ["NET-03/MV-04", /MV-04 does not continue the NET list/],
    ["NET-04/03", /slash list goes on with 03, not after 4/],
    ["NET-03/03", /slash list goes on with 03, not after 3/],
    ["MV-01 (basic)…03", /a range or slash after a parenthesised note/],
    ["MV-01, 17 (basic) / 18", /a range or slash after a parenthesised note/],
  ])(
    "refuse a backward range or slash list, a mixed prefix or a range after a note: %s",
    (text, error) => {
      expect(() => acceptanceIds(text)).toThrow(error);
    },
  );

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
