import { readFileSync } from "node:fs";
import { type CvarInfo, CvarRegistry } from "@game/shared";
import { describe, expect, it } from "vitest";
import { registerClientCvars } from "../../../client/src/console/clientCvars";
import { firstTable, mdSection } from "../../src/docs/mdTable";
import { fromRoot } from "../../src/paths";

// Doc-golden test (docs/06 §7, M2 design §4): the client cvar table names every cvar
// registerClientCvars registers, once, with its default ("off" for a false toggle) and, where the
// value is an ESTIMATE, that label.

function documented(): Map<string, { def: string; note: string }> {
  const doc = readFileSync(fromRoot("docs", "06-engine-architecture.md"), "utf8");
  const table = firstTable(mdSection(doc, "7. Client specifics"));
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

function shown(info: CvarInfo): string {
  return info.def.default === false ? "off" : String(info.def.default);
}

describe("client cvars in docs/06 §7", () => {
  const reg = new CvarRegistry();
  registerClientCvars(reg);
  const rows = documented();

  it("list exactly the registered client cvars", () => {
    expect([...rows.keys()].sort()).toEqual(
      reg
        .list()
        .map((i) => i.def.name)
        .sort(),
    );
  });

  it.each(reg.list().map((i) => [i.def.name, i] as const))("%s has its default", (name, info) => {
    expect(rows.get(name)?.def).toBe(shown(info));
  });

  it("label the ESTIMATEs that the source labels", () => {
    const sources = [
      "packages/client/src/console/clientCvars.ts",
      "packages/client/src/net/cvars.ts",
      "packages/client/src/render/viewCvars.ts",
    ].map((file) => readFileSync(fromRoot(file), "utf8"));
    for (const [name, row] of rows) {
      const source = sources.find((s) => s.includes(`name: "${name}"`)) ?? "";
      const block = source.slice(source.indexOf(`name: "${name}"`)).split("}),")[0] ?? "";
      expect(/ESTIMATE/.test(block), name).toBe(/ESTIMATE/.test(row.note));
    }
  });
});
