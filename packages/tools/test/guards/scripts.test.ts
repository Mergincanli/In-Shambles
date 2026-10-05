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
    }
    if (pkg === undefined) return [];
    return [{ pkg, script, failIfNoMatch: tokens.includes("--fail-if-no-match") }];
  });
}

describe("root scripts", () => {
  it("include every command in the CLAUDE.md commands table", () => {
    const table = claudeMd.split("## Commands")[1]?.split("\n## ")[0] ?? "";
    const commands = [...table.matchAll(/^\| `pnpm ([a-z:-]+)/gm)].map((m) => m[1] ?? "");
    expect(commands.length).toBeGreaterThan(10);
    for (const name of commands.filter((c) => c !== "install")) {
      expect(Object.keys(rootScripts), `pnpm ${name}`).toContain(name);
    }
  });

  it("never use a pnpm built-in command name (D-015)", () => {
    for (const name of Object.keys(rootScripts)) expect(PNPM_BUILTINS, name).not.toContain(name);
  });

  it("filter only real packages and scripts, and fail on an unmatched filter", () => {
    for (const [name, command] of Object.entries(rootScripts)) {
      for (const run of filteredRuns(command)) {
        expect(packageScripts.has(run.pkg), `${name}: ${run.pkg}`).toBe(true);
        expect(run.failIfNoMatch, `${name}: --fail-if-no-match`).toBe(true);
        expect(Object.keys(packageScripts.get(run.pkg) ?? {}), `${name}: ${run.script}`).toContain(
          run.script,
        );
      }
    }
  });

  it.each([
    ["pnpm --filter @game/server --fail-if-no-match start", [["@game/server", "start", true]]],
    ["pnpm --filter=@game/client dev", [["@game/client", "dev", false]]],
    ["pnpm -F @game/tools --fail-if-no-match run x --flag", [["@game/tools", "run", true]]],
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

describe("docs", () => {
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
      expect(readFileSync(file, "utf8"), file).not.toMatch(/pnpm [a-z:-]+ -- /);
    }
  });
});

describe("test:balance", () => {
  // `vitest run -t "^BAL-"` finds BAL tests by name and exits 0 if none match, so each
  // bal-NN-*.test.ts file must name its top-level describe after its ID (docs/10 §2).
  const testFiles = readdirSync(fromRoot("packages"), { recursive: true, encoding: "utf8" })
    .filter((file) => !file.includes("node_modules") && /\.test\.[cm]?[jt]sx?$/.test(file))
    .map((file) => join(fromRoot("packages"), file));
  const balFiles = testFiles.filter((file) => /^bal-\d+/i.test(basename(file)));

  it("includes BAL-01", () => {
    expect(balFiles.map((file) => basename(file))).toContainEqual(
      expect.stringMatching(/^bal-01-/i),
    );
  });

  it.each(balFiles.map((file) => [basename(file), file]))(
    "%s names its describe after its BAL ID",
    (name, file) => {
      const id = `BAL-${/^bal-(\d+)/i.exec(name)?.[1]}`;
      expect(readFileSync(file, "utf8")).toMatch(new RegExp(`describe\\(\\s*["'\`]${id}\\b`));
    },
  );
});

describe("stub scripts", () => {
  // CLAUDE.md: "Until their milestone, these are stubs that print "added in M#": `bench` (M1); ..."
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
