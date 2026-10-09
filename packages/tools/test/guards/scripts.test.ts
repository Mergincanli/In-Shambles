import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromRoot } from "../../src/paths";

const rootScripts: Record<string, string> = JSON.parse(
  readFileSync(fromRoot("package.json"), "utf8"),
).scripts;
const claudeMd = readFileSync(fromRoot("CLAUDE.md"), "utf8");

// pnpm 10 built-in commands, plus the npm commands pnpm passes through. A root script with one
// of these names never runs: `pnpm <name>` reaches the built-in instead (D-015). `test` and
// `start` are fine: those built-ins run the script.
const PNPM_BUILTINS = [
  "add",
  "approve-builds",
  "audit",
  "bin",
  "c",
  "cache",
  "cat-file",
  "cat-index",
  "completion",
  "config",
  "create",
  "dedupe",
  "deploy",
  "dlx",
  "doctor",
  "env",
  "exec",
  "fetch",
  "find-hash",
  "get",
  "help",
  "i",
  "ignored-builds",
  "import",
  "init",
  "install",
  "install-test",
  "it",
  "la",
  "licenses",
  "link",
  "list",
  "ll",
  "ln",
  "ls",
  "m",
  "multi",
  "outdated",
  "pack",
  "patch",
  "patch-commit",
  "patch-remove",
  "prune",
  "publish",
  "rb",
  "rebuild",
  "recursive",
  "remove",
  "rm",
  "root",
  "restart",
  "run",
  "self-update",
  "server",
  "set",
  "setup",
  "store",
  "t",
  "tst",
  "un",
  "uninstall",
  "unlink",
  "up",
  "update",
  "upgrade",
  "why",
  "access",
  "adduser",
  "bugs",
  "deprecate",
  "dist-tag",
  "docs",
  "edit",
  "info",
  "login",
  "logout",
  "owner",
  "ping",
  "prefix",
  "profile",
  "pkg",
  "repo",
  "s",
  "search",
  "show",
  "star",
  "stars",
  "team",
  "token",
  "unpublish",
  "unstar",
  "v",
  "version",
  "view",
  "whoami",
];

// Same set pnpm-workspace.yaml's packages/* resolves to: folders with a package.json.
const packageScripts = new Map<string, Record<string, string>>(
  readdirSync(fromRoot("packages"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(fromRoot("packages", e.name, "package.json")))
    .map((e) => {
      const pkg = JSON.parse(readFileSync(fromRoot("packages", e.name, "package.json"), "utf8"));
      return [pkg.name as string, (pkg.scripts ?? {}) as Record<string, string>];
    }),
);

/** Each `pnpm --filter`/`--filter=`/`-F` invocation in a command chain: package, script, flag. */
function filteredRuns(command: string) {
  return command.split(/&&|\|\||;|&/).flatMap((segment) => {
    const tokens = segment.trim().split(/\s+/);
    if (tokens[0] !== "pnpm") return [];
    let pkg: string | undefined;
    let script: string | undefined;
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i] ?? "";
      if (token === "--filter" || token === "-F") pkg = tokens[++i];
      else if (token.startsWith("--filter=")) pkg = token.slice("--filter=".length);
      else if (!token.startsWith("-") && script === undefined) script = token;
      // `pnpm ... run <script>` runs <script>; exec/dlx run a binary, not a package script.
      else if (!token.startsWith("-") && script === "run") script = token;
    }
    if (pkg === undefined) return [];
    if (script === "exec" || script === "dlx") script = undefined;
    return [{ pkg, script, failIfNoMatch: tokens.includes("--fail-if-no-match") }];
  });
}

describe("root scripts", () => {
  it("match the CLAUDE.md commands table, row for script", () => {
    const table = claudeMd.split("## Commands")[1]?.split("\n## ")[0] ?? "";
    const commands = [...table.matchAll(/^\| `pnpm ([a-z:-]+)/gm)].map((m) => m[1] ?? "");
    expect(commands.length).toBeGreaterThan(10);
    // `install` is the pnpm built-in. Scripts left out of the table on purpose go here.
    const tableOnly = ["install"];
    const undocumented: string[] = [];
    expect(commands.filter((c) => !tableOnly.includes(c)).sort()).toEqual(
      Object.keys(rootScripts)
        .filter((s) => !undocumented.includes(s))
        .sort(),
    );
  });

  it("never use a pnpm built-in command name (D-015)", () => {
    for (const name of Object.keys(rootScripts)) expect(PNPM_BUILTINS, name).not.toContain(name);
  });

  it("filter only real packages and scripts, and fail on an unmatched filter", () => {
    for (const [name, command] of Object.entries(rootScripts)) {
      for (const run of filteredRuns(command)) {
        expect(packageScripts.has(run.pkg), `${name}: ${run.pkg}`).toBe(true);
        expect(run.failIfNoMatch, `${name}: --fail-if-no-match`).toBe(true);
        if (run.script !== undefined) {
          expect(
            Object.keys(packageScripts.get(run.pkg) ?? {}),
            `${name}: ${run.script}`,
          ).toContain(run.script);
        }
      }
    }
  });

  it.each([
    ["pnpm --filter @game/server --fail-if-no-match start", [["@game/server", "start", true]]],
    ["pnpm --filter=@game/client dev", [["@game/client", "dev", false]]],
    ["pnpm -F @game/tools --fail-if-no-match run x --flag", [["@game/tools", "x", true]]],
    ["pnpm -F @game/tools --fail-if-no-match exec tsx bin.ts", [["@game/tools", undefined, true]]],
    [
      "pnpm -F a --fail-if-no-match build && pnpm --filter b test",
      [
        ["a", "build", true],
        ["b", "test", false],
      ],
    ],
  ])("parses %j", (command, expected) => {
    expect(filteredRuns(command).map((r) => [r.pkg, r.script, r.failIfNoMatch])).toEqual(expected);
  });
});

// Any pnpm invocation with a standalone `--` before more arguments, on one line of a code span.
const DOUBLE_DASH = /pnpm\b[^\n`|]*?\s--\s/;

describe("docs", () => {
  it.each([
    ["`pnpm bots -- --count 16`", true],
    ["`pnpm run bots -- --count 16`", true],
    ["`pnpm --filter @game/tools bench -- --x`", true],
    ["`pnpm bots --count 16 --profile wan-150-loss2`", false],
    ["`pnpm typecheck && pnpm lint`", false],
  ])("double-dash check on %s → %s", (text, flagged) => {
    expect(DOUBLE_DASH.test(text)).toBe(flagged);
  });

  // pnpm 10 hands `--` to the script as an argument, so `pnpm bots -- --count 16` would reach a
  // parseArgs-based CLI as positionals. Document `pnpm <script> --flag` instead.
  it("never pass `--` between a pnpm script and its flags", () => {
    const docs = ["CLAUDE.md", "README.md", "START_HERE.md", "docs", "prompts", ".claude"];
    const files = docs.flatMap((entry) =>
      entry.endsWith(".md")
        ? [fromRoot(entry)]
        : readdirSync(fromRoot(entry), { recursive: true, encoding: "utf8" })
            .filter((file) => file.endsWith(".md"))
            .map((file) => fromRoot(entry, file)),
    );
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(DOUBLE_DASH);
    }
  });
});

// `vitest run -t "^BAL-"` (and MV-, NET-) finds tests by their full name, which starts with the
// top-level describe, and exits 0 if none match. So each bal-NN / mv-NN / net-NN *.test.ts file
// must name its top-level describe after its ID (docs/10 §2), and the suite script must filter on
// that prefix, in both tiers (D-032) once the long tier holds any of the prefix's tests. The
// guard's own describe must not start with a prefix, or the suites would run it.
const packageFiles = readdirSync(fromRoot("packages"), { recursive: true, encoding: "utf8" })
  .filter((file) => !file.includes("node_modules"))
  .map((file) => join(fromRoot("packages"), file));
const testFiles = packageFiles.filter((file) => /\.test\.[cm]?[jt]sx?$/.test(file));
const longFiles = packageFiles.filter((file) => file.endsWith(".long.ts"));

/** Whether `file` has a top-level describe (or describe.each) starting with `prefix`-NN. */
function hasIdDescribe(file: string, prefix: string): boolean {
  const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return new RegExp(`^describe(\\.each\\([^\\n]*\\))?\\(\\s*["'\`]${prefix}-\\d`, "m").test(source);
}

/**
 * prefix, root script, IDs that must have a file (NET-01 is a shared unit test, D-026, so it has no
 * net-01 file; NET-02's unit is one too, `shared/test/net/delta.test.ts`, with its real-store twin
 * in `client/test/net/net-02-store.test.ts`; its match legs get net-02 files in M3 increment 9).
 * acceptance-ids.test.ts checks the full docs/09 lists.
 */
const ID_SUITES = [
  ["BAL", "test:balance", ["01"]],
  ["MV", "test:movement", ["01", "03", "04", "05", "06", "07", "08", "17", "18", "19"]],
  ["NET", "test:net", ["02", "03", "04", "05", "09"]],
] as const;

describe.each(ID_SUITES)("naming of the %s-NN test files", (prefix, script, required) => {
  const pattern = new RegExp(`^${prefix}-(\\d+)`, "i");
  const files = testFiles.filter((file) => pattern.test(basename(file)));

  it.each(required.map((id) => [id]))(`include ${prefix}-%s`, (id) => {
    expect(files.map((file) => basename(file))).toContainEqual(
      expect.stringMatching(new RegExp(`^${prefix}-${id}-`, "i")),
    );
  });

  // Pinned whole: a trailing `--project`, `--dir` or path would narrow the run to no ID test, and
  // vitest would still exit 0. Only the flag that shows the suites' printed reports may follow.
  // With long tests of the prefix (D-032), the fast run is followed by the long config's with the
  // same filter, so the suite runs every test of both tiers (`-t` matching nothing in one tier
  // still exits 0 there, its files skipped).
  it.runIf(files.length > 0)(`run under pnpm ${script}`, () => {
    const fast = `vitest run -t "\\^${prefix}-"( --silent=false)?`;
    const long = `vitest run --config vitest\\.long\\.config\\.ts -t "\\^${prefix}-"\\1`;
    const tiered = longFiles.some((file) => hasIdDescribe(file, prefix));
    expect(rootScripts[script]).toMatch(new RegExp(tiered ? `^${fast} && ${long}$` : `^${fast}$`));
  });

  it(`find ${prefix} long tests only in files named after their ID`, () => {
    for (const file of longFiles.filter((f) => hasIdDescribe(f, prefix))) {
      expect(basename(file), file).toMatch(pattern);
    }
  });

  it.each(files.map((file) => [basename(file), file]))(
    "%s names its top-level describe after its ID",
    (name, file) => {
      const id = `${prefix}-${pattern.exec(name)?.[1]}`;
      // Top level: at column 0, outside block comments (a line comment can't start with it).
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(source).toMatch(
        new RegExp(`^describe(\\.each\\([^\\n]*\\))?\\(\\s*["'\`]${id}\\b`, "m"),
      );
    },
  );

  it("never sit where the Vitest projects don't look (packages/<pkg>/test)", () => {
    for (const file of files) {
      expect(file.replace(fromRoot("packages"), "")).toMatch(/^[\\/][^\\/]+[\\/]test[\\/]/);
    }
  });
});

describe("stub scripts", () => {
  // CLAUDE.md: "Until their milestone, these are stubs that print "added in M#": `test:net`
  // (M2); ..."
  const sentence = /Until their milestone, these are stubs[^\n]*/.exec(claudeMd)?.[0] ?? "";
  const documented = new Map(
    sentence.split(";").flatMap((part) => {
      const milestone = /\((M\d+)\)/.exec(part)?.[1] ?? "";
      return [...part.matchAll(/`([a-z:-]+)`/g)].map((m) => [m[1] ?? "", milestone] as const);
    }),
  );
  const stubs = Object.entries(rootScripts).filter(([, command]) => command.includes("not-yet"));

  it("match the stub list in CLAUDE.md", () => {
    expect(stubs.length).toBeGreaterThan(0);
    expect(
      Object.fromEntries(stubs.map(([name, command]) => [name, command.split(" ").at(-1)])),
    ).toEqual(Object.fromEntries(documented));
  });

  it("match the later-milestone list in README.md", () => {
    const readme = readFileSync(fromRoot("README.md"), "utf8");
    const line = /Commands for later milestones \(([^)]*)\)/.exec(readme)?.[1] ?? "";
    const listed = [...line.matchAll(/`([a-z:-]+)`/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual(stubs.map(([name]) => name).sort());
  });

  it.each(stubs)("%s prints the milestone that adds it and exits 0", (name, command) => {
    const [, script, ...args] = command.split(" ");
    const run = spawnSync(process.execPath, [script ?? "", ...args], {
      cwd: fromRoot(),
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(`pnpm ${name}: added in ${documented.get(name)}`);
  });
});
