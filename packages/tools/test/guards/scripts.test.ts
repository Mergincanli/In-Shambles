import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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
  "run",
  "sbom",
  "self-update",
  "server",
  "set",
  "setup",
  "store",
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

const packageScripts = new Map<string, Record<string, string>>(
  readdirSync(fromRoot("packages")).map((dir) => {
    const pkg = JSON.parse(readFileSync(fromRoot("packages", dir, "package.json"), "utf8"));
    return [pkg.name as string, (pkg.scripts ?? {}) as Record<string, string>];
  }),
);

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
      for (const [, pkg, rest] of command.matchAll(/pnpm --filter (\S+) (.*)/g)) {
        expect(packageScripts.has(pkg ?? ""), `${name}: ${pkg}`).toBe(true);
        expect(rest, name).toContain("--fail-if-no-match");
        const script = rest?.replace("--fail-if-no-match", "").trim() ?? "";
        expect(Object.keys(packageScripts.get(pkg ?? "") ?? {}), `${name}: ${script}`).toContain(
          script,
        );
      }
    }
  });
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
