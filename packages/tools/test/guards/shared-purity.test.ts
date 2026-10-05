import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { scanSource } from "../../src/code/scan";
import { fromRoot } from "../../src/paths";

// CLAUDE.md golden rule 4 and .claude/rules/shared-simulation.md. shared's tsconfig (pinned by
// tsconfig-guard.test.ts) already rejects DOM and Node APIs: process, window, document,
// performance, timers, fetch, require and node: imports don't compile there. This scan covers
// what does compile: hidden randomness and wall-clock time, and DEV_ASSERT calls that allocate.
const FORBIDDEN: [string, RegExp][] = [
  ["Math.random", /\bMath\s*\.\s*random\b|\bMath\s*\[/],
  ["destructured Math.random", /\{[^}]*\brandom\b[^}]*\}\s*=\s*Math\b/],
  ["Date", /\bDate\s*(\.|\(|\[)|\bnew\s+Date\b/],
  ["globalThis", /\bglobalThis\b/],
];

/** Splits call arguments that start at `start` (just after the "(") at top-level commas. */
function topLevelArgs(code: string, start: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = start; i < code.length; i++) {
    const c = code[i] ?? "";
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  args.push(current);
  return args;
}

/**
 * DEV_ASSERT(condition, "message", detail?): the message must be a plain string literal and the
 * detail must not be computed by a call, so the success path never allocates (assert.ts).
 */
function devAssertViolations(code: string): string[] {
  // Calls only: `function DEV_ASSERT(` is the declaration itself.
  return [...code.matchAll(/(?<!\bfunction\s+)\bDEV_ASSERT\s*\(/g)].flatMap((match) => {
    const args = topLevelArgs(code, (match.index ?? 0) + match[0].length);
    const message = args[1]?.trim() ?? "";
    const problems: string[] = [];
    if (message !== '""' && message !== "''") problems.push("DEV_ASSERT non-literal message");
    if (args[2]?.includes("(")) problems.push("DEV_ASSERT computed detail");
    return problems;
  });
}

function violations(source: string): string[] {
  const { code } = scanSource(source);
  return [
    ...FORBIDDEN.filter(([, pattern]) => pattern.test(code)).map(([label]) => label),
    ...devAssertViolations(code),
  ];
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
    ["const { random } = Math;", "destructured Math.random"],
    ['const url = "http://x"; const t = Date.now();', "Date"],
    ["const url = `http://${host}`; const t = Date.now();", "Date"],
    ["const re = /\\/\\//; const t = Date.now();", "Date"],
    ["globalThis.x;", "globalThis"],
    ["DEV_ASSERT(v >= 0, `speed out of range`);", "DEV_ASSERT non-literal message"],
    ['DEV_ASSERT(v >= 0, "speed " + v);', "DEV_ASSERT non-literal message"],
    ['DEV_ASSERT(v >= 0, "speed out of range", String(v));', "DEV_ASSERT computed detail"],
  ])("flags %j", (source, label) => {
    expect(violations(source)).toContain(label);
  });

  it.each([
    ["// never use Date.now() here\n/* or Math.random */"],
    ['const s = "Math.random and Date.now in a string";'],
    ['DEV_ASSERT(v >= 0, "speed must be >= 0", v);'],
    ['DEV_ASSERT(isFinite(v[0]), "speed must be finite", v[0]);'],
    ["const { sqrt, abs } = Math;"],
    ["const window = [1, 2]; const n = window.length + window[0];"],
    ["const mathRandomSeed = rng.next();"],
    ["export function DEV_ASSERT(condition: unknown, message: string): void {}"],
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
