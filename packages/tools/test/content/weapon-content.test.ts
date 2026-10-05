import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanSource } from "../../src/code/scan";
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
// Short codes and anything with a digit (FN, M4, AK-47) match with exact case, so code-ish words
// like `fn` or `m4` don't trip the guard; longer names match in any case.
const banned = BANNED.map((term) => {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flags = term.length <= 4 || /\d/.test(term) ? "" : "i";
  return { term, pattern: new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, flags) };
});

function bannedTerms(text: string): string[] {
  return banned.filter(({ pattern }) => pattern.test(text)).map(({ term }) => term);
}

const CODE = /\.[cm]?[jt]sx?$/;

/** The text of every string and template literal in a source file, without comments or code. */
function stringLiterals(source: string): string {
  return scanSource(source).strings.join("\n");
}

/** What a player could see in a file: string literals for code, the whole text otherwise. */
function playerText(file: string): string {
  const text = readFileSync(file, "utf8");
  return CODE.test(file) ? stringLiterals(text) : text;
}

const TEXT_FILE = /\.([cm]?[jt]sx?|json|html?|css|svg|txt|md|webmanifest)$/;

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => TEXT_FILE.test(file))
    .map((file) => join(dir, file));
}

function playerFacingFiles(): string[] {
  const client = fromRoot("packages", "client");
  return [
    ...filesUnder(fromRoot("content", "names")),
    ...readdirSync(client)
      .filter((file) => file.endsWith(".html"))
      .map((file) => join(client, file)),
    ...filesUnder(join(client, "src")),
    ...filesUnder(join(client, "public")),
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
    ["FN Five"],
  ])("catches %j", (name) => {
    expect(bannedTerms(name)).not.toEqual([]);
  });

  it.each([["Grissino"], ["Knife"], ["Smoke grenade"], ["Mortadella"], ["Mark 4"]])(
    "allows %j",
    (name) => {
      expect(bannedTerms(name)).toEqual([]);
    },
  );

  it("reads code for its strings only, so identifiers and comments don't count", () => {
    const code = `// colt and FN in a comment\nconst fn = (m4: M, sig: S, p90: number) => m4.mul(sig);\nlabel("Grissino");`;
    expect(bannedTerms(stringLiterals(code))).toEqual([]);
    expect(bannedTerms(stringLiterals(`label("Colt Special"); hud(\`AK-47 \${n}\`);`))).toEqual(
      expect.arrayContaining(["Colt", "AK-47"]),
    );
  });

  it("scans the names files and the client's player-facing files", () => {
    const files = playerFacingFiles().map((file) => file.slice(fromRoot().length + 1));
    expect(files).toContain(join("content", "names", "weapons.json"));
    expect(files).toContain(join("packages", "client", "index.html"));
    expect(files).toContain(join("packages", "client", "src", "bootLabel.ts"));
  });

  it.each(playerFacingFiles().map((file) => [file.slice(fromRoot().length + 1), file]))(
    "%s has no trademarks or real gun names",
    (_name, file) => {
      expect(bannedTerms(playerText(file))).toEqual([]);
    },
  );
});
