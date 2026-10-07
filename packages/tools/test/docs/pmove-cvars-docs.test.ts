import { readFileSync } from "node:fs";
import { PMOVE_CVARS, type PmoveCvarLabel } from "@game/shared";
import { describe, expect, it } from "vitest";
import { firstTable, mdSection } from "../../src/docs/mdTable";
import { fromRoot } from "../../src/paths";

// Doc-golden test (M2 plan, "New tunables"): PMOVE_CVARS defaults and labels must equal the
// docs/03 §2.1–§2.3 tables, and every row M2 simulates must be registered.

interface DocRow {
  section: string;
  default: number;
  /** The Label column; "FACT-Q3" for §2.1, whose heading labels the whole table. */
  label: string;
}

const doc = readFileSync(fromRoot("docs", "03-movement-spec.md"), "utf8");

/** §2.2 is the UrT layer; M2 uses only this row of it (the rest arrive with M4). */
const M2_FROM_URT_LAYER = ["pm_autoHop"];

function cvarName(cell: string): string {
  const m = /^`(pm_[A-Za-z0-9]+)`$/.exec(cell);
  if (!m?.[1]) throw new Error(`unexpected cvar cell "${cell}"`);
  return m[1];
}

function defaultValue(name: string, cell: string): number {
  if (!/^-?\d+(\.\d+)?$/.test(cell)) throw new Error(`${name}: default "${cell}" is not a number`);
  return Number(cell);
}

const LABELS = ["FACT", "INFERRED", "ESTIMATE"];

function label(name: string, cell: string): string {
  if (!LABELS.includes(cell)) throw new Error(`${name}: unexpected label "${cell}"`);
  return cell;
}

/** Rows of one §2.x table keyed by cvar name; `fixedLabel` for §2.1, which has no Label column. */
function tableRows(
  heading: string,
  headers: string[],
  fixedLabel?: PmoveCvarLabel,
): Map<string, DocRow> {
  const table = firstTable(mdSection(doc, heading));
  expect(table.headers, heading).toEqual(headers);
  const rows = new Map<string, DocRow>();
  for (const cells of table.rows) {
    const name = cvarName(cells[0] ?? "");
    if (rows.has(name)) throw new Error(`${heading}: duplicate row ${name}`);
    const value = defaultValue(name, cells[1] ?? "");
    rows.set(name, {
      section: heading,
      default: value,
      label: fixedLabel ?? label(name, cells[2] ?? ""),
    });
  }
  return rows;
}

describe("PMOVE_CVARS vs docs/03 §2", () => {
  it("§2.1 is the Q3 baseline, FACT for Q3", () => {
    expect(doc).toMatch(/^### 2\.1 Base constants \(Q3 baseline, FACT for Q3\b/m);
  });

  const base = tableRows("2.1 Base constants", ["Cvar", "Default", "Meaning"], "FACT-Q3");
  const urt = tableRows("2.2 UrT layer constants", ["Cvar", "Default", "Label", "Notes"]);
  const m2 = tableRows("2.3 M2 base additions", ["Cvar", "Default", "Label", "Meaning"]);
  const registered = new Map(PMOVE_CVARS.map((r) => [r.name, r]));

  it("registers every row M2 uses: all of §2.1 and §2.3, and pm_autoHop from §2.2", () => {
    const used = [...base.keys(), ...M2_FROM_URT_LAYER, ...m2.keys()];
    for (const name of M2_FROM_URT_LAYER) expect(urt.has(name), name).toBe(true);
    expect([...registered.keys()].sort()).toEqual([...used].sort());
  });

  it("matches each documented default and label", () => {
    for (const r of PMOVE_CVARS) {
      const row = base.get(r.name) ?? urt.get(r.name) ?? m2.get(r.name);
      expect(row, `${r.name} is documented`).toBeDefined();
      expect({ name: r.name, default: r.default, label: r.label }).toEqual({
        name: r.name,
        default: row?.default,
        label: row?.label,
      });
    }
  });

  it("documents each cvar in one table only", () => {
    for (const name of registered.keys()) {
      const hits = [base, urt, m2].filter((t) => t.has(name)).length;
      expect(hits, name).toBe(1);
    }
  });
});
