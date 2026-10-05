import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { DETERMINISTIC_MATH_RULES } from "../../src/code/deterministicMath";
import { scanSource } from "../../src/code/scan";
import { fromRoot } from "../../src/paths";

// CLAUDE.md golden rule 4 and .claude/rules/shared-simulation.md. shared's tsconfig (pinned by
// tsconfig-guard.test.ts) already rejects DOM and Node APIs: process, window, document,
// performance, timers, fetch, require and node: imports don't compile there. This scan covers
// what does compile: hidden randomness and wall-clock time, engine-approximated math (D-016), and
// DEV_ASSERT calls that allocate.
const FORBIDDEN: (readonly [string, RegExp])[] = [
  ["Math.random", /\bMath\s*\.\s*random\b/],
  ["destructured Math.random", /\{[^}]*\brandom\b[^}]*\}\s*=\s*Math\b/],
  ["Date", /\bDate\s*(\.|\(|\[)|\bnew\s+Date\b/],
  ["globalThis", /\bglobalThis\b/],
  ...DETERMINISTIC_MATH_RULES,
];

/** Splits call arguments that start at `start` (just after the "(") at top-level commas. */
function topLevelArgs(code: string, start: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let inTemplate = false;
  let current = "";
  for (let i = start; i < code.length; i++) {
    const c = code[i] ?? "";
    if (c === "`" && depth === 0) inTemplate = !inTemplate;
    else if (inTemplate && depth === 0) {
      // Template text: no argument boundaries in here.
    } else if (c === "(" || c === "[" || c === "{") depth++;
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

// A detail that can't allocate: a variable, member or index access, a number, a string literal.
const PLAIN_DETAIL = /^\s*(-?\s*[\w$]+(\s*(\.\s*[\w$]+|\[[^\]()]*\]))*|""|''|-?\d[\w.]*)\s*$/;

/**
 * DEV_ASSERT(condition, "message", detail?): the message must be a plain string literal and the
 * detail a plain value (no call, template or concatenation), so the success path never allocates
 * (assert.ts).
 */
function devAssertViolations(code: string): string[] {
  // Calls only: `function DEV_ASSERT(` is the declaration itself.
  return [...code.matchAll(/(?<!\bfunction\s+)\bDEV_ASSERT\s*\(/g)].flatMap((match) => {
    const args = topLevelArgs(code, (match.index ?? 0) + match[0].length);
    const message = args[1]?.trim() ?? "";
    const problems: string[] = [];
    if (message !== '""' && message !== "''") problems.push("DEV_ASSERT non-literal message");
    const detail = args[2]?.trim() ?? "";
    if (detail !== "" && !PLAIN_DETAIL.test(detail)) problems.push("DEV_ASSERT computed detail");
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
    ['const r = Math["random"]();', "Math outside the exact-op allowlist"],
    ["const r = Math.random();", "Math outside the exact-op allowlist"],
    ["const { random } = Math;", "destructured Math.random"],
    ['const url = "http://x"; const t = Date.now();', "Date"],
    ["const url = `http://${host}`; const t = Date.now();", "Date"],
    ["const re = /\\/\\//; const t = Date.now();", "Date"],
    ["globalThis.x;", "globalThis"],
    ["DEV_ASSERT(v >= 0, `speed out of range`);", "DEV_ASSERT non-literal message"],
    ['DEV_ASSERT(v >= 0, "speed " + v);', "DEV_ASSERT non-literal message"],
    ['DEV_ASSERT(v >= 0, "speed out of range", String(v));', "DEV_ASSERT computed detail"],
    ['DEV_ASSERT(ok, "bad position", `${x},${y}`);', "DEV_ASSERT computed detail"],
    ['DEV_ASSERT(ok, "bad y", "y=" + y);', "DEV_ASSERT computed detail"],
    ["const s = Math.sin(a);", "Math.sin"],
    ["const c = Math . cos(a);", "Math.cos"],
    ["const t = Math.atan2(y, x);", "Math.atan2"],
    ["const h = Math.hypot(x, y);", "Math.hypot"],
    ["const p = Math.pow(x, 1.6);", "Math.pow"],
    ["const e = Math.exp(x) + Math.log(x);", "Math.exp"],
    ["const e = Math.exp(x) + Math.log(x);", "Math.log"],
    ["const l = Math.log2(x);", "Math.log2"],
    ["const f = Math.sin;", "Math.sin"],
    ['const s = Math["sin"](a);', "Math outside the exact-op allowlist"],
    ["const s = Math?.sin(a);", "Math outside the exact-op allowlist"],
    ["const s = (Math).sin(a);", "Math outside the exact-op allowlist"],
    ["const M = Math; const s = M.sin(a);", "Math outside the exact-op allowlist"],
    ['const s = Reflect.get(Math, "sin")(a);', "Math outside the exact-op allowlist"],
    ["const { a: { b }, sin } = Math;", "Math outside the exact-op allowlist"],
    ["const { sqrt, abs } = Math;", "Math outside the exact-op allowlist"],
    ["const x = Math.sumPrecise(xs);", "Math outside the exact-op allowlist"],
    ["const label = `${Math.sin(a)}`;", "Math.sin"],
    ["const label = `${x ** 2}`;", "exponent operator **"],
    ["const { sin, cos } = Math;", "destructured Math.sin"],
    ["const { sin, cos } = Math;", "destructured Math.cos"],
    ["const { PI, tanh: t } = Math;", "destructured Math.tanh"],
    ["const y = x ** 1.6;", "exponent operator **"],
    ["const y = 2**31;", "exponent operator **"],
    ["y **= 2;", "exponent operator **"],
  ])("flags %j", (source, label) => {
    expect(violations(source)).toContain(label);
  });

  it.each([
    ["// never use Date.now() here\n/* or Math.random */"],
    ['const s = "Math.random and Date.now in a string";'],
    ['DEV_ASSERT(v >= 0, "speed must be >= 0", v);'],
    ['DEV_ASSERT(isFinite(v[0]), "speed must be finite", v[0]);'],
    ['DEV_ASSERT(ok, "bad z", ps.pos[2]);'],
    ['DEV_ASSERT(ok, "bad z", -z);'],
    ['DEV_ASSERT(ok, "bad state", "falling");'],
    ["const window = [1, 2]; const n = window.length + window[0];"],
    ["const mathRandomSeed = rng.next();"],
    ["export function DEV_ASSERT(condition: unknown, message: string): void {}"],
    ["const r = Math.sqrt(x) + Math.fround(y) + Math.round(z) + Math.imul(a, b);"],
    ["const half = Math.PI / 2 + Math.SQRT1_2 + Math.abs(x) + Math.floor(y);"],
    ["const m = Math.max(a, b) + Math.min(a, b) + Math.sign(x) + Math.clz32(n);"],
    ["const r = Math\n  .sqrt(x) + Math . trunc(y);"],
    ["const v = config.Math + ns.Math;"],
    ['const s = "use Math.sin or x ** 2 in tests only";'],
    ["// Math.cos(x) and a ** b are banned\n/** Math.atan2 is approximate (D-016) */"],
    ["const cosine = dcos(x); const sine = sinU16(a); const logger = log;"],
    ["const s = table.sin(x) + wave.cos;"],
    ["const re = /Math.sin|a**b/;"],
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
