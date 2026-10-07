import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { scanSource } from "../../src/code/scan";
import { parseJsonc } from "../../src/jsonc";
import { fromRoot } from "../../src/paths";

// The client's net code (packages/client/src/net) runs in the browser, in the Node NET tests and
// in the M3 bots (M2 design §1), so it reaches time only through the injected clock and nothing
// of its environment. tsconfig.net.json (lib ES2023, types []) refuses DOM and Node globals; this
// scan also catches what still compiles: the wall clock, Math.random, timers and imports beyond
// @game/shared and its own modules.
const FORBIDDEN: (readonly [string, RegExp])[] = [
  ["Date", /\bDate\b/],
  ["performance", /\bperformance\b/],
  ["Math.random", /\bMath\s*\.\s*random\b|\{[^}]*\brandom\b[^}]*\}\s*=\s*Math\b/],
  ["timer", /\b(setTimeout|setInterval|setImmediate|requestAnimationFrame)\b/],
  ["process", /\bprocess\b/],
  ["globalThis", /\bglobalThis\b/],
  ["DOM global", /\b(window|document|navigator|localStorage)\b/],
  ["require", /\brequire\s*\(/],
  ["dynamic import", /\bimport\s*\(/],
];

function specifiers(source: string): string[] {
  return [...source.matchAll(/(?:\bfrom|^\s*import)\s*["']([^"']+)["']/gm)].map((m) => m[1] ?? "");
}

/** What `source` (at `file`, relative to src/net) breaks. */
function violations(source: string, file = "example.ts"): string[] {
  const { code } = scanSource(source);
  const found = FORBIDDEN.filter(([, pattern]) => pattern.test(code)).map(([label]) => label);
  for (const spec of specifiers(source)) {
    if (spec === "@game/shared") continue;
    const resolved = posix.normalize(posix.join(posix.dirname(file), spec));
    if (!spec.startsWith(".") || resolved.startsWith("..")) found.push(`import ${spec}`);
  }
  return found;
}

describe("client net purity guard", () => {
  it.each([
    ["const t = Date.now();", "Date"],
    ["const t = performance.now();", "performance"],
    ["const r = Math.random();", "Math.random"],
    ["const { random } = Math;", "Math.random"],
    ["requestAnimationFrame(frame);", "timer"],
    ["setTimeout(f, 1);", "timer"],
    ["setInterval(f, 16);", "timer"],
    ["const t = process.hrtime();", "process"],
    ["globalThis.foo = 1;", "globalThis"],
    ["window.addEventListener('x', f);", "DOM global"],
    ["document.title = 'x';", "DOM global"],
    ['const fs = require("node:fs");', "require"],
    ['const m = await import("./clock");', "dynamic import"],
    ['import { Match } from "@game/server";', "import @game/server"],
    ['import { x } from "../render/space";', "import ../render/space"],
  ])("flags %j", (source, label) => {
    expect(violations(source)).toContain(label);
  });

  it.each([
    ['import { pmove } from "@game/shared";'],
    ['import { ClientClock } from "./clock";'],
    ["const yaw = Math.atan2(dy, dx); // input generation, not simulation"],
    ["this.now[0] = this.clockFn();"],
  ])("allows %j", (source) => {
    expect(violations(source)).toEqual([]);
  });

  const root = fromRoot("packages", "client", "src", "net");
  const files = readdirSync(root).filter((f) => /\.[cm]?[jt]sx?$/.test(f));
  it.each(files.map((f) => [f, join(root, f)]))("%s uses no environment APIs", (name, file) => {
    expect(violations(readFileSync(file, "utf8"), relative(root, file) || name)).toEqual([]);
  });

  it("is type-checked on its own and exported as @game/client/net", () => {
    const config = parseJsonc(
      readFileSync(fromRoot("packages", "client", "tsconfig.net.json"), "utf8"),
    ) as { include: string[] };
    expect(config.include).toEqual(["src/net"]);
    const pkg = JSON.parse(readFileSync(fromRoot("packages", "client", "package.json"), "utf8"));
    expect(pkg.exports).toEqual({ "./net": "./src/net/index.ts" });
    expect(pkg.scripts.typecheck).toContain("tsconfig.net.json");
  });
});
