import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { scanSource } from "../../src/code/scan";
import { parseJsonc } from "../../src/jsonc";
import { fromRoot } from "../../src/paths";

// The server's match code runs unchanged in a Web Worker and in Node (D-027, docs/06 §4), so it
// reaches the clock, timers and logs only through LoopHost. tsconfig.match.json (lib ES2023,
// types []) already refuses DOM and Node globals; this scan also catches what still compiles or
// hides in strings: wall-clock and hidden time, Math.random, timers by any route, process, and
// imports of anything but @game/shared and the match's own modules.
const FORBIDDEN: (readonly [string, RegExp])[] = [
  ["Date", /\bDate\b/],
  ["performance", /\bperformance\b/],
  ["Math.random", /\bMath\s*\.\s*random\b|\{[^}]*\brandom\b[^}]*\}\s*=\s*Math\b/],
  ["timer", /\b(setTimeout|setInterval|setImmediate|clearTimeout|clearInterval)\b/],
  ["process", /\bprocess\b/],
  ["globalThis", /\bglobalThis\b/],
  ["require", /\brequire\s*\(/],
  ["dynamic import", /\bimport\s*\(/],
  ["unicode escape outside a string", /\\u/],
];

/** Module specifiers of static imports and re-exports (`from "x"`, `import "x"`). */
function specifiers(source: string): string[] {
  return [...source.matchAll(/(?:\bfrom|^\s*import)\s*["']([^"']+)["']/gm)].map((m) => m[1] ?? "");
}

/**
 * What `source` breaks; `file` is its path under packages/server/src. A relative import must
 * resolve inside src/match (so `./../main` cannot pull the Node entry in unscanned).
 */
function violations(source: string, file = "match/example.ts"): string[] {
  const { code } = scanSource(source);
  const found = FORBIDDEN.filter(([, pattern]) => pattern.test(code)).map(([label]) => label);
  for (const spec of specifiers(source)) {
    if (spec === "@game/shared") continue;
    const resolved = posix.normalize(posix.join(posix.dirname(file), spec));
    if (!spec.startsWith(".") || !resolved.startsWith("match/")) found.push(`import ${spec}`);
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

describe("server match purity guard", () => {
  it.each([
    ["const t = Date.now();", "Date"],
    ["const t = performance.now();", "performance"],
    ["const r = Math.random();", "Math.random"],
    ["const { random } = Math;", "Math.random"],
    ["setTimeout(tick, 16);", "timer"],
    ["const id = setInterval(tick, 16);", "timer"],
    ["if (process.env.X) {}", "process"],
    ["globalThis.setTimeout(f, 1);", "globalThis"],
    ['const fs = require("fs");', "require"],
    ['const m = await import("node:fs");', "dynamic import"],
    ['import { readFileSync } from "node:fs";', "import node:fs"],
    ['import { Worker } from "worker_threads";', "import worker_threads"],
    ['export * from "../main";', "import ../main"],
    ['export * from "./../main";', "import ./../main"],
    ['import { x } from "./util/../../main";', "import ./util/../../main"],
    ['import "node:perf_hooks";', "import node:perf_hooks"],
    ["const t = \\u0044ate.now();", "unicode escape outside a string"],
  ])("flags %j", (source, label) => {
    expect(violations(source)).toContain(label);
  });

  it("flags an index.ts import of anything but the match modules", () => {
    expect(violations('export * from "./main";', "index.ts")).toEqual(["import ./main"]);
    expect(violations('export * from "./match/loop";', "index.ts")).toEqual([]);
  });

  it.each([
    ['import { pmove } from "@game/shared";'],
    ['import type { LoopHost } from "./host";'],
    ['export * from "./match/loop";'],
    ["// never use Date.now() or setTimeout here"],
    ['host.log("warn", "performance: the process fell behind");'],
    ["const updated = lastDate + toDate(x); const processed = 1;"],
    ["host.schedule(this.wakeCb, ms);"],
  ])("allows %j", (source) => {
    expect(violations(source)).toEqual([]);
  });

  const root = fromRoot("packages", "server", "src");
  const files = [...sourceFiles(join(root, "match")), join(root, "index.ts")];
  it.each(files.map((file) => [relative(root, file), file]))(
    "%s uses no environment APIs",
    (_name, file) => {
      const rel = relative(root, file).split("\\").join("/");
      expect(violations(readFileSync(file, "utf8"), rel)).toEqual([]);
    },
  );

  it("the server's package entry and typecheck cover the match code", () => {
    const config = parseJsonc(
      readFileSync(fromRoot("packages", "server", "tsconfig.match.json"), "utf8"),
    ) as { include: string[] };
    expect(config.include.sort()).toEqual(["src/index.ts", "src/match"]);
    const pkg = JSON.parse(readFileSync(fromRoot("packages", "server", "package.json"), "utf8"));
    // The one other entry is the Node host (M3 design §1), outside the scanned match code.
    expect(pkg.exports).toEqual({ ".": "./src/index.ts", "./node": "./src/node/index.ts" });
    expect(pkg.scripts.typecheck).toContain("tsconfig.match.json");
  });
});
