import { readFileSync } from "node:fs";
import { NET_PROFILES, type NetProfile } from "@game/shared";
import { describe, expect, it } from "vitest";
import { firstTable, mdSection } from "../../src/docs/mdTable";
import { fromRoot } from "../../src/paths";

// Doc-golden test (D-028): docs/10 §3 is the canonical net profile table and docs/05 §13 repeats
// it; NET_PROFILES (packages/shared/src/net/profiles.ts) must equal both, row for row.

function readDoc(name: string): string {
  return readFileSync(fromRoot("docs", name), "utf8");
}

/** "0", "25 ms", "±3", "±15 ms": milliseconds. */
function ms(cell: string): number {
  const m = /^±?(\d+(?:\.\d+)?)(?: ms)?$/.exec(cell);
  if (!m) throw new Error(`unexpected time "${cell}"`);
  return Number(m[1]);
}

/** "0", "1%", "0.5%": a probability. */
function rate(cell: string): number {
  if (cell === "0") return 0;
  const m = /^(\d+(?:\.\d+)?)%$/.exec(cell);
  if (!m) throw new Error(`unexpected rate "${cell}"`);
  return Number(m[1]) / 100;
}

function profilesIn(section: string, columns: readonly string[]): NetProfile[] {
  const table = firstTable(section);
  expect(table.headers).toEqual(columns);
  return table.rows.map((row) => {
    const name = /^`([a-z0-9-]+)`$/.exec(row[0] ?? "")?.[1];
    if (!name) throw new Error(`unexpected profile cell "${row[0]}"`);
    return {
      name,
      delayMs: ms(row[1] ?? ""),
      jitterMs: ms(row[2] ?? ""),
      loss: rate(row[3] ?? ""),
      duplicate: rate(row[4] ?? ""),
      reorder: rate(row[5] ?? ""),
    };
  });
}

describe("network profiles in the docs", () => {
  it("docs/10 §3 (canonical) equals NET_PROFILES", () => {
    const section = mdSection(readDoc("10-testing-and-performance.md"), "3. Network profiles");
    const columns = ["Profile", "One-way delay", "Jitter", "Loss", "Dup", "Reorder"];
    expect(profilesIn(section, columns)).toEqual(NET_PROFILES.map((p) => ({ ...p })));
  });

  it("docs/05 §13 repeats the same table", () => {
    const section = mdSection(readDoc("05-netcode.md"), "13. Tooling");
    const columns = ["Profile", "Delay (one-way)", "Jitter", "Loss", "Dup", "Reorder"];
    expect(profilesIn(section, columns)).toEqual(NET_PROFILES.map((p) => ({ ...p })));
  });
});
