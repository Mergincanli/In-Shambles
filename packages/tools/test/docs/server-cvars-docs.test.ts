import { readFileSync } from "node:fs";
import { registerServerCvars } from "@game/server/node";
import { CvarFlag, CvarRegistry } from "@game/shared";
import { describe, expect, it } from "vitest";
import { firstTable, mdSection } from "../../src/docs/mdTable";
import { fromRoot } from "../../src/paths";

// Doc-golden test (docs/06 §8, M3 design §4): the server cvar table names every cvar
// registerServerCvars registers, once, with its default and, where the source labels the value an
// ESTIMATE, that label. Every one is SERVER-only, never replicated.

function documented(): Map<string, { def: string; note: string }> {
  const doc = readFileSync(fromRoot("docs", "06-engine-architecture.md"), "utf8");
  const table = firstTable(mdSection(doc, "8. Server specifics"));
  expect(table.headers).toEqual(["Cvar", "Default", "Label / note"]);
  const out = new Map<string, { def: string; note: string }>();
  for (const row of table.rows) {
    const name = /^`([A-Za-z_]+)`$/.exec(row[0] ?? "")?.[1];
    if (name === undefined) throw new Error(`unexpected cvar cell "${row[0]}"`);
    expect(out.has(name), name).toBe(false);
    out.set(name, { def: row[1] ?? "", note: row[2] ?? "" });
  }
  return out;
}

describe("server cvars in docs/06 §8", () => {
  const reg = new CvarRegistry();
  registerServerCvars(reg);
  const rows = documented();
  const source = readFileSync(fromRoot("packages/server/src/node/serverCvars.ts"), "utf8");

  it("list exactly the registered server cvars", () => {
    expect([...rows.keys()].sort()).toEqual(
      reg
        .list()
        .map((i) => i.def.name)
        .sort(),
    );
  });

  it.each(reg.list().map((i) => [i.def.name, i] as const))("%s", (name, info) => {
    // An empty string default is written `""`.
    const def = info.def.default === "" ? '""' : String(info.def.default);
    expect(rows.get(name)?.def).toBe(def);
    expect(info.def.flags).toBe(CvarFlag.SERVER);
    const block = source.slice(source.indexOf(`name: "${name}"`)).split("});")[0] ?? "";
    expect(/ESTIMATE/.test(block), name).toBe(/ESTIMATE/.test(rows.get(name)?.note ?? ""));
  });
});
