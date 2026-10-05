import { describe, expect, it } from "vitest";
import { parseDamageTableDoc, parseWeaponIdsDoc } from "../src/content/weaponDocs";

const HEADER = "| ID | Head | Helmet | Torso | Vest | Arms | Groin | Butt | U.leg | L.leg | Foot |";
const SEPARATOR = "|---|---|---|---|---|---|---|---|---|---|---|";
const damageDoc = (...rows: string[]) =>
  ["## 4. Damage table (FACT)", "", HEADER, SEPARATOR, ...rows, ""].join("\n");
const ROW = "| rifle_ar | 100 | 51 | 44 | 29 | 17 | 31 | 28 | 20 | 17 | 14 |";

describe("parseDamageTableDoc", () => {
  it("maps columns to zone keys and strips row notes from IDs", () => {
    const rows = parseDamageTableDoc(
      damageDoc(ROW, ROW.replace("rifle_ar", "launcher_40mm (impact)")),
    );
    expect(Object.keys(rows)).toEqual(["rifle_ar", "launcher_40mm"]);
    expect(rows.rifle_ar).toEqual({
      head: 100,
      helmet: 51,
      torso: 44,
      vest: 29,
      arms: 17,
      groin: 31,
      butt: 28,
      upperLeg: 20,
      lowerLeg: 17,
      foot: 14,
    });
  });

  it("throws when the columns change", () => {
    const doc = damageDoc(ROW).replace("| Butt |", "| Rear |");
    expect(() => parseDamageTableDoc(doc)).toThrow(/unexpected damage table columns/);
  });

  it("throws on a duplicate weapon ID", () => {
    expect(() => parseDamageTableDoc(damageDoc(ROW, ROW))).toThrow(/duplicate weapon ID/);
  });

  it("throws on a cell that isn't an integer", () => {
    expect(() => parseDamageTableDoc(damageDoc(ROW.replace("| 44 |", "| — |")))).toThrow(
      /rifle_ar\.torso: "—" is not an integer/,
    );
  });

  it("throws on an invalid weapon ID", () => {
    expect(() => parseDamageTableDoc(damageDoc(ROW.replace("rifle_ar", "Rifle AR")))).toThrow(
      /invalid weapon ID/,
    );
  });
});

describe("parseWeaponIdsDoc", () => {
  const idsDoc = (...rows: string[]) =>
    [
      "## 2. Stable IDs",
      "",
      "| ID | UrT reference | Slot | Notes |",
      "|---|---|---|---|",
      ...rows,
    ].join("\n");

  it("returns IDs without backticks, with their references, in doc order", () => {
    expect(
      parseWeaponIdsDoc(
        idsDoc("| `rifle_ar` | LR300 / M4 | primary | |", "| `lmg` | Negev | primary | |"),
      ),
    ).toEqual([
      { id: "rifle_ar", reference: "LR300 / M4" },
      { id: "lmg", reference: "Negev" },
    ]);
  });

  it("throws when the columns change or an ID is invalid", () => {
    expect(() =>
      parseWeaponIdsDoc(idsDoc("| `x` | y | z | |").replace("UrT reference", "Original")),
    ).toThrow(/unexpected weapon ID table columns/);
    expect(() => parseWeaponIdsDoc(idsDoc("| `Rifle-AR` | y | z | |"))).toThrow(
      /invalid weapon ID/,
    );
  });
});
