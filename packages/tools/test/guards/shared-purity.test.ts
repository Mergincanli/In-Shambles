import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { fromRoot } from "../../src/paths";

// CLAUDE.md golden rule 4 and .claude/rules/shared-simulation.md: the shared sim has no
// hidden time, no unseeded randomness and no environment APIs.
const FORBIDDEN: [string, RegExp][] = [
  ["Math.random", /\bMath\.random\b/],
  ["Date.now", /\bDate\.now\b/],
  ["new Date", /\bnew\s+Date\b/],
  ["performance.now", /\bperformance\.now\b/],
  ["process", /\bprocess\./],
  ["window", /\bwindow\./],
  ["document", /\bdocument\./],
  ["timers", /\b(setTimeout|setInterval|setImmediate)\b/],
  ["fetch", /\bfetch\s*\(/],
  ["node: import", /\bfrom\s+["']node:/],
  ["require", /\brequire\s*\(/],
  // DEV_ASSERT messages are string literals; templates allocate on every call (assert.ts).
  ["DEV_ASSERT template message", /\bDEV_ASSERT\s*\([^`;]*?,\s*`/],
];

function violations(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return FORBIDDEN.filter(([, pattern]) => pattern.test(code)).map(([label]) => label);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("shared purity guard", () => {
  it("flags forbidden APIs but ignores comments", () => {
    expect(violations("const t = Date.now();\nconst r = Math.random();")).toEqual([
      "Math.random",
      "Date.now",
    ]);
    expect(violations("// never use Date.now() here\n/* or Math.random */")).toEqual([]);
    expect(violations("DEV_ASSERT(v >= 0, `speed out of range`);")).toEqual([
      "DEV_ASSERT template message",
    ]);
    expect(violations('DEV_ASSERT(v >= 0, "speed must be >= 0", v);')).toEqual([]);
  });

  const root = fromRoot("packages", "shared", "src");
  it.each(sourceFiles(root).map((file) => [relative(root, file), file]))(
    "%s uses no forbidden APIs",
    (_name, file) => {
      expect(violations(readFileSync(file, "utf8"))).toEqual([]);
    },
  );
});
