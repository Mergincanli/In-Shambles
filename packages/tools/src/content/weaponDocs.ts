import { firstTable, mdSection } from "../docs/mdTable";

/** docs/04 §4 damage-table columns, in doc order, mapped to zone keys (docs/04 §3.1 plus armor variants). */
export const DAMAGE_COLUMNS = {
  Head: "head",
  Helmet: "helmet",
  Torso: "torso",
  Vest: "vest",
  Arms: "arms",
  Groin: "groin",
  Butt: "butt",
  "U.leg": "upperLeg",
  "L.leg": "lowerLeg",
  Foot: "foot",
} as const;

export type DamageZone = (typeof DAMAGE_COLUMNS)[keyof typeof DAMAGE_COLUMNS];
export type DamageRow = Record<DamageZone, number>;

export interface WeaponRef {
  id: string;
  /** Name of the original weapon; reference only, never player-facing. */
  reference: string;
}

const ID = /^[a-z0-9_]+$/;

/** Parse the FACT damage table (docs/04 §4) into rows keyed by weapon ID. */
export function parseDamageTableDoc(markdown: string): Record<string, DamageRow> {
  const table = firstTable(mdSection(markdown, "4. Damage table"));
  const expectedHeaders = ["ID", ...Object.keys(DAMAGE_COLUMNS)];
  if (table.headers.join("|") !== expectedHeaders.join("|")) {
    throw new Error(`unexpected damage table columns: ${table.headers.join(", ")}`);
  }

  const zones = Object.values(DAMAGE_COLUMNS);
  const rows: Record<string, DamageRow> = {};
  for (const [label = "", ...cells] of table.rows) {
    // "launcher_40mm (impact)" → "launcher_40mm"
    const id = label.split(/\s+/)[0] ?? "";
    if (!ID.test(id)) throw new Error(`invalid weapon ID in damage table: "${label}"`);
    if (id in rows) throw new Error(`duplicate weapon ID in damage table: ${id}`);

    const row = {} as DamageRow;
    zones.forEach((zone, i) => {
      const cell = cells[i] ?? "";
      if (!/^\d+$/.test(cell)) throw new Error(`${id}.${zone}: "${cell}" is not an integer`);
      row[zone] = Number(cell);
    });
    rows[id] = row;
  }
  return rows;
}

/** Parse the stable weapon IDs (docs/04 §2), in doc order. */
export function parseWeaponIdsDoc(markdown: string): WeaponRef[] {
  const table = firstTable(mdSection(markdown, "2. Stable IDs"));
  if (table.headers[0] !== "ID" || table.headers[1] !== "UrT reference") {
    throw new Error(`unexpected weapon ID table columns: ${table.headers.join(", ")}`);
  }
  return table.rows.map(([idCell = "", reference = ""]) => {
    const id = idCell.replaceAll("`", "");
    if (!ID.test(id)) throw new Error(`invalid weapon ID in §2: "${idCell}"`);
    return { id, reference };
  });
}
