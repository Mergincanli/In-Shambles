import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWeaponIdsDoc } from "../../src/content/weaponDocs";
import { fromRoot } from "../../src/paths";

const readJson = <T>(...path: string[]): T =>
  JSON.parse(readFileSync(fromRoot(...path), "utf8")) as T;

const refs = parseWeaponIdsDoc(readFileSync(fromRoot("docs", "04-combat-and-balance.md"), "utf8"));
const ids = refs.map((ref) => ref.id);
const names = readJson<Record<string, { name: string; typeTag: string }>>(
  "content",
  "names",
  "weapons.json",
);
const damage = readJson<{ weapons: Record<string, unknown> }>("content", "weapons", "damage.json");

describe("weapon content", () => {
  it("names every docs/04 §2 weapon ID, and nothing else", () => {
    expect(Object.keys(names).sort()).toEqual([...ids].sort());
  });

  it("gives every weapon a name and a type tag", () => {
    for (const [id, entry] of Object.entries(names)) {
      expect(entry.name, id).not.toBe("");
      expect(entry.typeTag, id).not.toBe("");
    }
  });

  it("only uses docs/04 §2 IDs in the damage table", () => {
    for (const id of Object.keys(damage.weapons)) expect(ids).toContain(id);
  });

  // CLAUDE.md golden rule 2: no trademarks or original weapon names in player-facing text.
  it("contains no trademarks or original weapon names", () => {
    const generic = new Set(["Knife", "HE grenade", "Smoke grenade"]);
    const banned = ["Urban Terror", "UrT", "FrozenSand", ...refs.map((ref) => ref.reference)]
      .flatMap((term) => term.split(" / "))
      .filter((term) => !generic.has(term));
    const text = JSON.stringify(names);
    for (const term of banned) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(text, term).not.toMatch(new RegExp(`(^|\\W)${escaped}(\\W|$)`, "i"));
    }
  });
});
