import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type DamageRow, parseDamageTableDoc } from "../../src/content/weaponDocs";
import { fromRoot } from "../../src/paths";

const doc = readFileSync(fromRoot("docs", "04-combat-and-balance.md"), "utf8");
const data = JSON.parse(readFileSync(fromRoot("content", "weapons", "damage.json"), "utf8")) as {
  label: string;
  weapons: Record<string, DamageRow>;
};

describe("BAL-01: damage.json equals the docs/04 §4 table exactly", () => {
  const fromDoc = parseDamageTableDoc(doc);

  it("has the same weapons, zones and values as the doc", () => {
    expect(data.weapons).toEqual(fromDoc);
  });

  it("covers all 20 weapon rows and is labeled FACT", () => {
    expect(Object.keys(fromDoc)).toHaveLength(20);
    expect(data.label).toBe("FACT");
  });

  // Hand-checked anchors so a parser bug can't make the doc and the JSON agree on wrong values.
  it.each([
    ["rifle_ar", { head: 100, helmet: 51, torso: 44, vest: 29, foot: 14 }],
    ["sniper_bolt_heavy", { vest: 100, butt: 97, upperLeg: 60 }],
    ["lmg", { head: 50, lowerLeg: 11, foot: 9 }],
    ["launcher_40mm", { head: 20, torso: 20, foot: 20 }],
    ["smg_mp", { groin: 16, butt: 15, arms: 13 }],
  ])("%s matches hand-checked values", (id, expected) => {
    expect(data.weapons[id]).toMatchObject(expected);
  });
});
