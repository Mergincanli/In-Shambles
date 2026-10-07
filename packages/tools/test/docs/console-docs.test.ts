import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_BINDS } from "../../../client/src/console/binds";
import { CONSOLE_COMMANDS } from "../../../client/src/console/commands";
import { firstTable, mdSection } from "../../src/docs/mdTable";
import { fromRoot } from "../../src/paths";

// Doc-golden test (docs/06 §6): the table of console commands implemented in M2 and the default
// binds table match the client's CONSOLE_COMMANDS and DEFAULT_BINDS.

const section = mdSection(
  readFileSync(fromRoot("docs", "06-engine-architecture.md"), "utf8"),
  "6. Cvars and console",
);

/** The first table after the bullet that starts with `marker`. */
function tableAfter(marker: string) {
  const at = section.indexOf(marker);
  if (at < 0) throw new Error(`"${marker}" not found in docs/06 §6`);
  return firstTable(section.slice(at));
}

/** The backticked names in a cell, in order. */
function codes(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
}

describe("console docs in docs/06 §6", () => {
  it("list exactly the implemented console commands", () => {
    const table = tableAfter("**Implemented in M2**");
    expect(table.headers).toEqual(["Command", "Effect"]);
    const names = table.rows.map((row) => (codes(row[0] ?? "")[0] ?? "").split(" ")[0]);
    expect(names).toEqual(CONSOLE_COMMANDS.map(([name]) => name));
  });

  it("list exactly the default binds", () => {
    const table = tableAfter("**Default binds**");
    expect(table.headers).toEqual(["Key (`code`)", "Bind"]);
    const binds: [string, string][] = [];
    for (const row of table.rows) {
      const keys = codes(row[0] ?? "");
      // A row may pair several keys with as many binds (`KeyW` / `KeyS` → `+forward` / `+back`);
      // the bind cell's first backticked names, one per key, are the commands.
      const commands = codes(row[1] ?? "").slice(0, keys.length);
      expect(commands.length, row[0]).toBe(keys.length);
      keys.forEach((key, i) => {
        binds.push([key, commands[i] as string]);
      });
    }
    const sort = (list: readonly (readonly [string, string])[]) =>
      list.map(([k, c]) => `${k} ${c}`).sort();
    expect(sort(binds)).toEqual(sort(DEFAULT_BINDS));
  });
});
