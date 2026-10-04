import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { fromRoot } from "../../src/paths";

// CLAUDE.md golden rule 4 and .claude/rules/shared-simulation.md: the shared sim has no
// hidden time, no unseeded randomness and no environment APIs. The compiler settings catch
// most of this (tsconfig-guard.test.ts); this scan catches what type-checks anyway.
const FORBIDDEN: [string, RegExp][] = [
  ["Math.random", /\bMath\s*\.\s*random\b|\bMath\s*\[/],
  ["destructured Math", /\}\s*=\s*Math\b/],
  ["Date", /\bDate\s*(\.|\(|\[)|\bnew\s+Date\b/],
  ["performance", /\bperformance\b/],
  ["process", /\bprocess\s*(\.|\[)/],
  ["window", /\bwindow\s*(\.|\[)/],
  ["document", /\bdocument\s*(\.|\[)/],
  ["globalThis", /\bglobalThis\b/],
  ["timers", /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\b/],
  ["fetch", /\bfetch\s*\(/],
  ["node: import", /\bfrom\s+["']node:|\bimport\s*\(\s*["']node:/],
  ["require", /\brequire\s*\(/],
  // DEV_ASSERT messages are string literals; templates allocate on every call (assert.ts).
  ["DEV_ASSERT template message", /\bDEV_ASSERT\s*\([^`;]*?,\s*`/],
];

/**
 * Blank out string contents first, so `//` inside a string doesn't hide the rest of the line.
 * Module specifiers (`from "x"`, `import("x")`, `require("x")`) are kept for the import checks.
 */
function codeOnly(source: string): string {
  return source
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (s, offset: number, all: string) =>
      /(\bfrom|\bimport|\brequire)\s*\(?\s*$/.test(all.slice(Math.max(0, offset - 12), offset))
        ? s
        : `${s[0]}${s[0]}`,
    )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function violations(source: string): string[] {
  const code = codeOnly(source);
  return FORBIDDEN.filter(([, pattern]) => pattern.test(code)).map(([label]) => label);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

describe("shared purity guard", () => {
  it.each([
    ["const t = Date.now();", "Date"],
    ["const d = Date();", "Date"],
    ["const d = new Date(0);", "Date"],
    ["const r = Math.random();", "Math.random"],
    ['const r = Math["random"]();', "Math.random"],
    ["const { random } = Math;", "destructured Math"],
    ['const url = "http://x"; const t = performance.now();', "performance"],
    ["globalThis.fetch;", "globalThis"],
    ['import { readFileSync } from "node:fs";', "node: import"],
    ["DEV_ASSERT(v >= 0, `speed out of range`);", "DEV_ASSERT template message"],
  ])("flags %j", (source, label) => {
    expect(violations(source)).toContain(label);
  });

  it.each([
    ["// never use Date.now() here\n/* or Math.random */"],
    ['const s = "Math.random and Date.now in a string";'],
    ['DEV_ASSERT(v >= 0, "speed must be >= 0", v);'],
    ["const mathRandomSeed = rng.next();"],
  ])("allows %j", (source) => {
    expect(violations(source)).toEqual([]);
  });

  const root = fromRoot("packages", "shared", "src");
  it.each(sourceFiles(root).map((file) => [relative(root, file), file]))(
    "%s uses no forbidden APIs",
    (_name, file) => {
      expect(violations(readFileSync(file, "utf8"))).toEqual([]);
    },
  );
});
