import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DETERMINISTIC_MATH_RULES } from "../../src/code/deterministicMath";
import { scanSource } from "../../src/code/scan";
import { fromRoot } from "../../src/paths";

// docs/07 §2 and .claude/rules/content-and-ip.md: compiled maps are byte-identical for identical
// input, so the greybox modules that produce .cmap bytes read no clock, randomness, locale or
// environment, and (D-016) no engine-approximated math, since a map compiled on one machine must
// match one compiled on any other. Only the CLI entry (cli.ts, M1 increment 8) may touch the
// process and file paths; the bytes it writes still come from the other modules.
const CLI_ENTRY = "cli.ts";

const EVERYWHERE: (readonly [string, RegExp])[] = [
  ["Date", /\bDate\b/],
  ["performance", /\bperformance\b/],
  ["Math.random", /\bMath\s*\.\s*random\b/],
  ["localeCompare", /\blocaleCompare\b/],
  ["Intl", /\bIntl\b/],
  ["toLocale*", /\btoLocale\w*\b/],
  ...DETERMINISTIC_MATH_RULES,
];

const OUTSIDE_CLI: (readonly [string, RegExp])[] = [
  ["process", /\bprocess\b/],
  ["__dirname", /\b__dirname\b/],
  ["__filename", /\b__filename\b/],
  ["import.meta", /\bimport\s*\.\s*meta\b/],
  ["node: import", /\bfrom\s*["']node:|\bimport\s*\(\s*["']node:/],
];

function violations(source: string, isCli: boolean): string[] {
  // Import specifiers are strings, so check them on the source, everything else on the code.
  const { code } = scanSource(source);
  const rules = isCli ? EVERYWHERE : [...EVERYWHERE, ...OUTSIDE_CLI];
  return rules
    .filter(([label, pattern]) => pattern.test(label === "node: import" ? source : code))
    .map(([label]) => label);
}

describe("greybox determinism guard", () => {
  it.each([
    ["const t = Date.now();", "Date"],
    ["const t = new Date();", "Date"],
    ["const t = performance.now();", "performance"],
    ["const r = Math.random();", "Math.random"],
    ["keys.sort((a, b) => a.localeCompare(b));", "localeCompare"],
    ["const s = new Intl.Collator().compare;", "Intl"],
    ["const s = n.toLocaleString();", "toLocale*"],
    ["const dir = process.cwd();", "process"],
    ["const here = __dirname;", "__dirname"],
    ["const url = import.meta.url;", "import.meta"],
    ['import { readFileSync } from "node:fs";', "node: import"],
    ["const s = Math.sin(a);", "Math.sin"],
    ["const h = Math.hypot(x, y);", "Math.hypot"],
    ["const rise = run * (1 - nz ** 2) ** 0.5;", "exponent operator **"],
    ['const c = Math["cos"](a);', "Math outside the exact-op allowlist"],
  ])("flags %j", (source, label) => {
    expect(violations(source, false)).toContain(label);
  });

  it.each([
    ['const s = "Date.now and localeCompare in a string";'],
    ["// never Date.now() or process.cwd() here"],
    ["const updated = dateless + processed;"],
    ["const rise = (run * Math.sqrt(1 - nz * nz)) / nz + Math.fround(x) + Math.max(a, b);"],
  ])("allows %j", (source) => {
    expect(violations(source, false)).toEqual([]);
  });

  it("lets only the CLI entry use the process and file paths", () => {
    expect(violations("const dir = process.cwd();", true)).toEqual([]);
    expect(violations("const t = Date.now();", true)).toEqual(["Date"]);
  });

  const root = fromRoot("packages", "tools", "src", "greybox");
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((name) =>
    /\.[cm]?[jt]sx?$/.test(name),
  );
  it.each(files)(
    "%s reads no clock, randomness, locale, environment or approximate math",
    (name) => {
      expect(violations(readFileSync(join(root, name), "utf8"), name === CLI_ENTRY)).toEqual([]);
    },
  );

  it("catches a banned Math call added to the compiler", () => {
    const source = readFileSync(join(root, "brushCompiler.ts"), "utf8");
    expect(violations(source, false)).toEqual([]);
    const probed = `${source}\nexport const probe = Math.atan2(1, 2);\n`;
    expect(violations(probed, false)).toContain("Math.atan2");
  });
});
