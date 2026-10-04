import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWeaponIdsDoc } from "../../src/content/weaponDocs";
import { fromRoot } from "../../src/paths";

const readJson = <T>(...path: string[]): T =>
  JSON.parse(readFileSync(fromRoot(...path), "utf8")) as T;

const refs = parseWeaponIdsDoc(readFileSync(fromRoot("docs", "04-combat-and-balance.md"), "utf8"));
const ids = refs.map((ref) => ref.id);
const names = readJson<Record<string, { name?: unknown; typeTag?: unknown }>>(
  "content",
  "names",
  "weapons.json",
);
const damage = readJson<{ weapons: Record<string, unknown> }>("content", "weapons", "damage.json");

const TYPE_TAGS = [
  "Knife",
  "Pistol",
  "Revolver",
  "SMG",
  "Shotgun",
  "Launcher",
  "Rifle",
  "LMG",
  "Sniper",
  "Grenade",
];

describe("weapon content", () => {
  it("names every docs/04 §2 weapon ID, and nothing else", () => {
    expect(Object.keys(names).sort()).toEqual([...ids].sort());
  });

  it("gives every weapon a non-empty name and a known type tag", () => {
    for (const [id, entry] of Object.entries(names)) {
      expect(Object.keys(entry).sort(), `${id} keys`).toEqual(["name", "typeTag"]);
      expect(typeof entry.name === "string" && entry.name.trim() !== "", `${id}.name`).toBe(true);
      expect(TYPE_TAGS, `${id}.typeTag`).toContain(entry.typeTag);
    }
  });

  it("only uses docs/04 §2 IDs in the damage table", () => {
    for (const id of Object.keys(damage.weapons)) expect(ids).toContain(id);
  });
});

// CLAUDE.md golden rule 2: no trademarks or real gun brand names in player-facing text.
// Banned: the game and studio names, every original weapon from docs/04 §2, and the brands
// and model families behind them. Generic words ("Knife", "Smoke grenade") stay allowed.
const GENERIC = new Set(["Knife", "HE grenade", "Smoke grenade"]);
const BRANDS = [
  "Barrett",
  "Benelli",
  "Beretta",
  "Colt",
  "Desert Eagle",
  "FN",
  "FN Herstal",
  "Franchi",
  "Glock",
  "Heckler & Koch",
  "HK",
  "IMI",
  "Ingram",
  "IWI",
  "Kalashnikov",
  "Magnum",
  "Magnum Research",
  "Mossberg",
  "Remington",
  "Ruger",
  "SIG",
  "Sig Sauer",
  "Smith & Wesson",
  "Steyr",
  "Uzi",
  "Walther",
  "AK",
  "AK-47",
  "AK-74",
  "AK-103",
  "AR-15",
  "FR-F1",
  "G36",
  "HK69",
  "LR300",
  "M4",
  "M16",
  "MAC-10",
  "MAC-11",
  "MP5",
  "MP5K",
  "Negev",
  "P90",
  "PSG-1",
  "PSG1",
  "SPAS",
  "SPAS-12",
  "SR-8",
  "UMP",
  "UMP45",
];
const BANNED = [
  "Urban Terror",
  "UrT",
  "FrozenSand",
  ...BRANDS,
  ...refs.flatMap((ref) => ref.reference.split(" / ")).filter((term) => !GENERIC.has(term)),
];
const banned = BANNED.map((term) => {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { term, pattern: new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, "i") };
});

function bannedTerms(text: string): string[] {
  return banned.filter(({ pattern }) => pattern.test(text)).map(({ term }) => term);
}

function playerFacingFiles(): string[] {
  const namesDir = fromRoot("content", "names");
  const clientSrc = fromRoot("packages", "client", "src");
  return [
    ...readdirSync(namesDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => join(namesDir, file)),
    fromRoot("packages", "client", "index.html"),
    ...readdirSync(clientSrc, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .map((file) => join(clientSrc, file)),
  ];
}

describe("trademark guard", () => {
  it.each([
    ["Beretta"],
    ["Colt Special"],
    ["AK-47"],
    ["the Desert Eagle"],
    ["Heckler & Koch"],
    ["UrT Classic"],
  ])("catches %j", (name) => {
    expect(bannedTerms(name)).not.toEqual([]);
  });

  it.each([["Grissino"], ["Knife"], ["Smoke grenade"], ["Mortadella"], ["Mark 4"]])(
    "allows %j",
    (name) => {
      expect(bannedTerms(name)).toEqual([]);
    },
  );

  it.each(playerFacingFiles().map((file) => [file.slice(fromRoot().length + 1), file]))(
    "%s has no trademarks or real gun names",
    (_name, file) => {
      expect(bannedTerms(readFileSync(file, "utf8"))).toEqual([]);
    },
  );
});
