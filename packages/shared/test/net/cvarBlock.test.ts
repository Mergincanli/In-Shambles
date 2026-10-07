import { describe, expect, it } from "vitest";
import { CvarFlag } from "../../src/cvars/flags";
import { type CvarDef, CvarRegistry } from "../../src/cvars/registry";
import { BitWriter } from "../../src/net/bitstream";
import {
  applyCvarBlock,
  CVAR_HASH_SEED,
  CvarBlock,
  captureCvarBlock,
  cvarBlockHash,
  cvarHash16,
  decodeCvarBlock,
  encodeCvarBlock,
  registryCvarHash,
} from "../../src/net/cvarBlock";
import { murmur3Bytes } from "../../src/rng/hash32";
import { Mulberry32 } from "../../src/rng/mulberry32";
import { PMOVE_CVARS, registerPmoveCvars } from "../../src/sim/pmove/params";
import { newWriter, randomBlock, readerOver } from "../helpers/netMessages";

const R = CvarFlag.REPLICATED;

/** A small registry with one cvar of each kind, two of them not replicated. */
function smallDefs(): CvarDef[] {
  return [
    { name: "sv_fps", type: "int", default: 60, min: 1, max: 1000, description: "", flags: R },
    { name: "pm_gravity", type: "float", default: 800, description: "", flags: R },
    { name: "g_friendlyFire", type: "bool", default: true, description: "", flags: R },
    { name: "g_motd", type: "string", default: "hi", description: "", flags: R },
    { name: "cl_fov", type: "float", default: 90, description: "", flags: CvarFlag.ARCHIVE },
    { name: "sv_hostname", type: "string", default: "x", description: "", flags: CvarFlag.SERVER },
  ];
}

function registry(defs: readonly CvarDef[]): CvarRegistry {
  const reg = new CvarRegistry();
  for (const d of defs) reg.register(d);
  return reg;
}

function encoded(block: CvarBlock): Uint8Array {
  const w = newWriter();
  encodeCvarBlock(w, block);
  expect(w.error).toBe(false);
  return w.bytes.slice(0, w.byteLength);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The pmove cvars registered in a given row order. */
function pmoveRegistry(order: readonly number[]): CvarRegistry {
  const reg = new CvarRegistry();
  for (const i of order) {
    const r = PMOVE_CVARS[i];
    if (r === undefined) throw new Error("bad row");
    reg.register({
      name: r.name,
      type: r.type,
      default: r.default,
      min: r.min,
      max: r.max,
      description: r.description,
      flags: R,
    });
  }
  return reg;
}

describe("replicated cvar block (D-027)", () => {
  it("lists the REPLICATED cvars only, sorted by lowercase name", () => {
    const block = captureCvarBlock(registry(smallDefs()), new CvarBlock());
    expect(block.entries.map((e) => e.name)).toEqual([
      "g_friendlyFire",
      "g_motd",
      "pm_gravity",
      "sv_fps",
    ]);
  });

  it("has a pinned byte layout and hash (golden: changing either is a protocol change)", () => {
    const reg = registry(smallDefs());
    const block = captureCvarBlock(reg, new CvarBlock());
    const bytes = encoded(block);
    expect(hex(bytes)).toBe(
      "0438e7af599e2ebbc9ecbc312d2fdb387fdb6f3a7901745a81b7bf6779d89ea6e7030000000000480432e6f6af193e8707000000",
    );
    expect(CVAR_HASH_SEED).toBe(0x63766172);
    expect(cvarBlockHash(block)).toBe(murmur3Bytes(bytes, CVAR_HASH_SEED));
    expect(cvarBlockHash(block)).toBe(0x6b77c540);
    expect(registryCvarHash(reg)).toBe(cvarBlockHash(block));
    expect(cvarHash16(0x12345678)).toBe(0x5678);
    expect(cvarHash16(0xffffffff)).toBe(0xffff);
    // −1 is cvarBlockHash's "unencodable", never a hash to send.
    expect(() => cvarHash16(-1)).toThrow(/valid block hash/);
  });

  it("pins the hash of the default M2 movement cvars", () => {
    const reg = new CvarRegistry();
    registerPmoveCvars(reg);
    expect(registryCvarHash(reg)).toBe(0x11df56b6);
  });

  it("does not depend on registration order or on non-replicated cvars", () => {
    const n = PMOVE_CVARS.length;
    const forward = Array.from({ length: n }, (_, i) => i);
    const hash = registryCvarHash(pmoveRegistry(forward));
    expect(registryCvarHash(pmoveRegistry([...forward].reverse()))).toBe(hash);
    const rng = new Mulberry32(0x0dde);
    for (let k = 0; k < 10; k++) {
      const shuffled = [...forward];
      for (let i = n - 1; i > 0; i--) {
        const j = rng.nextInt(i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j] as number, shuffled[i] as number];
      }
      const reg = pmoveRegistry(shuffled);
      reg.register({ name: "cl_extra", type: "int", default: 3, description: "" });
      expect(registryCvarHash(reg)).toBe(hash);
    }
  });

  it("changes with any value, and only replicated values", () => {
    const reg = registry(smallDefs());
    const base = registryCvarHash(reg);
    reg.set("cl_fov", 100);
    reg.set("sv_hostname", "other");
    expect(registryCvarHash(reg)).toBe(base);
    const seen = new Set([base]);
    for (const [name, value] of [
      ["pm_gravity", 800.0000000000001],
      ["sv_fps", 61],
      ["g_friendlyFire", false],
      ["g_motd", "hi!"],
    ] as const) {
      reg.set(name, value);
      const h = registryCvarHash(reg);
      expect(seen.has(h), name).toBe(false);
      seen.add(h);
    }
  });

  it("round-trips floats exactly, whatever their bits", () => {
    const reg = registry([
      { name: "a", type: "float", default: 0, description: "", flags: R },
      { name: "b", type: "float", default: 0, description: "", flags: R },
      { name: "c", type: "float", default: 0, description: "", flags: R },
      { name: "d", type: "float", default: 0, description: "", flags: R },
      { name: "e", type: "float", default: 0, description: "", flags: R },
    ]);
    const values = [0.1 + 0.2, Number.MIN_VALUE, -Number.MAX_VALUE, 1 / 3, -0];
    for (const [i, name] of ["a", "b", "c", "d", "e"].entries()) reg.set(name, values[i] as number);
    const block = captureCvarBlock(reg, new CvarBlock());
    const out = new CvarBlock();
    expect(decodeCvarBlock(readerOver(encoded(block)), out)).toBe(true);
    // −0 is stored as 0 by the registry.
    expect(out.entries.map((e) => e.value)).toEqual([
      0.1 + 0.2,
      Number.MIN_VALUE,
      -Number.MAX_VALUE,
      1 / 3,
      0,
    ]);
    expect(Object.is(out.entries[4]?.value, 0)).toBe(true);
    for (let i = 0; i < 4; i++) expect(Object.is(out.entries[i]?.value, values[i])).toBe(true);
  });

  it("round-trips seeded random blocks byte for byte", () => {
    const rng = new Mulberry32(0xb10c);
    const block = new CvarBlock();
    const out = new CvarBlock();
    for (let i = 0; i < 300; i++) {
      randomBlock(rng, block, 40);
      const bytes = encoded(block);
      const r = readerOver(bytes);
      expect(decodeCvarBlock(r, out)).toBe(true);
      expect(r.atEnd()).toBe(true);
      expect(out.entries).toEqual(block.entries);
      expect(hex(encoded(out))).toBe(hex(bytes));
      expect(cvarBlockHash(out)).toBe(cvarBlockHash(block));
    }
  });

  it("refuses to encode a block that isn't canonical", () => {
    const bad: CvarBlock["entries"][] = [
      [
        { name: "b", type: "int", value: 1 },
        { name: "a", type: "int", value: 1 },
      ],
      [
        { name: "a", type: "int", value: 1 },
        { name: "A", type: "int", value: 1 },
      ],
      [{ name: "Bad", type: "int", value: 1 }],
      [{ name: "a".repeat(64), type: "int", value: 1 }],
      [{ name: "a", type: "int", value: 1.5 }],
      [{ name: "a", type: "int", value: 2147483648 }],
      [{ name: "a", type: "float", value: Number.NaN }],
      [{ name: "a", type: "float", value: Number.POSITIVE_INFINITY }],
      [{ name: "a", type: "float", value: -0 }],
      [{ name: "a", type: "bool", value: 1 }],
      [{ name: "a", type: "string", value: "é" }],
      [{ name: "a", type: "string", value: "x".repeat(256) }],
    ];
    for (const entries of bad) {
      const block = new CvarBlock();
      block.entries.push(...entries);
      const w = new BitWriter(4096);
      encodeCvarBlock(w, block);
      expect(w.error, JSON.stringify(entries)).toBe(true);
      expect(cvarBlockHash(block)).toBe(-1);
    }
  });

  it("refuses to decode out-of-order or duplicate names and non-finite floats", () => {
    const out = new CvarBlock();
    // Hand-written blocks with the canonical checks bypassed.
    const raw = (write: (w: BitWriter) => void) => {
      const w = newWriter();
      write(w);
      return readerOver(w.bytes.slice(0, w.byteLength));
    };
    const name = (w: BitWriter, s: string) => {
      w.writeBits(s.length, 6);
      for (let i = 0; i < s.length; i++) w.writeBits(s.charCodeAt(i), 7);
    };
    const intEntry = (w: BitWriter, s: string) => {
      name(w, s);
      w.writeBits(0, 2);
      w.writeSigned(1, 32);
    };
    expect(
      decodeCvarBlock(
        raw((w) => {
          w.writeBits(2, 10);
          intEntry(w, "a");
          intEntry(w, "b");
        }),
        out,
      ),
    ).toBe(true);
    for (const [label, write] of [
      [
        "order",
        (w: BitWriter) => {
          w.writeBits(2, 10);
          intEntry(w, "b");
          intEntry(w, "a");
        },
      ],
      [
        "duplicate",
        (w: BitWriter) => {
          w.writeBits(2, 10);
          intEntry(w, "a");
          intEntry(w, "a");
        },
      ],
      [
        "name grammar",
        (w: BitWriter) => {
          w.writeBits(1, 10);
          intEntry(w, "9a");
        },
      ],
      [
        "NaN",
        (w: BitWriter) => {
          w.writeBits(1, 10);
          name(w, "a");
          w.writeBits(1, 2);
          w.writeF64(Number.NaN);
        },
      ],
      [
        "−0",
        (w: BitWriter) => {
          w.writeBits(1, 10);
          name(w, "a");
          w.writeBits(1, 2);
          w.writeF64(-0);
        },
      ],
      [
        "short",
        (w: BitWriter) => {
          w.writeBits(3, 10);
          intEntry(w, "a");
        },
      ],
    ] as const) {
      expect(decodeCvarBlock(raw(write), out), label).toBe(false);
    }
  });

  describe("apply", () => {
    function serverBlock(edit: (reg: CvarRegistry) => void): CvarBlock {
      const server = registry(smallDefs());
      edit(server);
      const out = new CvarBlock();
      // Through the wire, as a client receives it.
      expect(
        decodeCvarBlock(readerOver(encoded(captureCvarBlock(server, new CvarBlock()))), out),
      ).toBe(true);
      return out;
    }

    it("sets the client's mirror to the server's values, after which the hashes agree", () => {
      const block = serverBlock((s) => {
        s.set("pm_gravity", 400.5);
        s.set("g_motd", "welcome");
        s.set("cl_fov", 120);
      });
      const client = registry(smallDefs());
      client.set("cl_fov", 75);
      const version = client.version;
      expect(applyCvarBlock(client, block)).toEqual({ ok: true, changed: 2 });
      expect(client.get("pm_gravity")).toBe(400.5);
      expect(client.get("g_motd")).toBe("welcome");
      // Not replicated: the client's own value stays.
      expect(client.get("cl_fov")).toBe(75);
      expect(client.version).toBeGreaterThan(version);
      expect(registryCvarHash(client)).toBe(cvarBlockHash(block));
      expect(applyCvarBlock(client, block)).toEqual({ ok: true, changed: 0 });
    });

    function rejects(block: CvarBlock, client: CvarRegistry, error: string, name: string) {
      const version = client.version;
      const before = registryCvarHash(client);
      expect(applyCvarBlock(client, block)).toEqual({ ok: false, error, name });
      expect(client.version).toBe(version);
      expect(registryCvarHash(client)).toBe(before);
    }

    it("is all or nothing: unknown names, wrong kinds, bad ranges and missing cvars change nothing", () => {
      const good = serverBlock((s) => s.set("pm_gravity", 100));
      const edited = (i: number, entry: CvarBlock["entries"][number]) => {
        const b = new CvarBlock();
        b.entries.push(...good.entries);
        b.entries[i] = entry;
        return b;
      };
      // g_friendlyFire, g_motd, pm_gravity, sv_fps; the client sees pm_gravity first changed.
      rejects(
        edited(3, { name: "sv_fpz", type: "int", value: 60 }),
        registry(smallDefs()),
        "unknown",
        "sv_fpz",
      );
      // Spelled differently from the registration: the hash would differ, so it is unknown.
      rejects(
        edited(3, { name: "SV_fps", type: "int", value: 60 }),
        registry(smallDefs()),
        "unknown",
        "SV_fps",
      );
      const swapped = new CvarBlock();
      swapped.entries.push(...good.entries);
      swapped.entries.reverse();
      rejects(swapped, registry(smallDefs()), "order", "pm_gravity");
      rejects(
        edited(1, { name: "g_motd", type: "int", value: 3 }),
        registry(smallDefs()),
        "type",
        "g_motd",
      );
      rejects(
        edited(3, { name: "sv_fps", type: "int", value: 0 }),
        registry(smallDefs()),
        "range",
        "sv_fps",
      );
      rejects(
        edited(3, { name: "sv_fps", type: "int", value: 1001 }),
        registry(smallDefs()),
        "range",
        "sv_fps",
      );
      const fewer = new CvarBlock();
      fewer.entries.push(...good.entries.slice(0, 3));
      rejects(fewer, registry(smallDefs()), "missing", "sv_fps");
      const extra = registry(smallDefs());
      extra.register({ name: "zz_new", type: "int", default: 0, description: "", flags: R });
      rejects(good, extra, "missing", "zz_new");
      const local = registry(
        smallDefs().map((d) => (d.name === "sv_fps" ? { ...d, flags: 0 } : d)),
      );
      rejects(good, local, "not-replicated", "sv_fps");
    });

    it("takes the server's CHEAT and LATCH values as sent, whatever the mirror's cheat setting", () => {
      const defs = smallDefs().map((d) =>
        d.name === "pm_gravity"
          ? { ...d, flags: R | CvarFlag.CHEAT }
          : d.name === "sv_fps"
            ? { ...d, flags: R | CvarFlag.LATCH }
            : d,
      );
      const server = registry(defs);
      server.setAllowCheats(true);
      server.set("pm_gravity", 300);
      server.set("sv_fps", 120);
      server.applyLatched();
      const block = captureCvarBlock(server, new CvarBlock());
      // The mirror's cheats are off and its own LATCH rule would hold sv_fps back: neither applies.
      const client = registry(defs);
      client.set("sv_fps", 30);
      expect(client.info("sv_fps")?.latched).toBe(30);
      expect(applyCvarBlock(client, block)).toEqual({ ok: true, changed: 2 });
      expect(client.get("pm_gravity")).toBe(300);
      expect(client.get("sv_fps")).toBe(120);
      expect(client.info("sv_fps")?.latched).toBeUndefined();
      expect(registryCvarHash(client)).toBe(registryCvarHash(server));
      // The unchanged block applies again, and the server's own LATCH cvar went out unchanged.
      expect(applyCvarBlock(client, block)).toEqual({ ok: true, changed: 0 });
    });

    it("refuses an unencodable string even in a hand-built block, changing nothing", () => {
      const good = serverBlock(() => {});
      const b = new CvarBlock();
      b.entries.push(...good.entries);
      b.entries[1] = { name: "g_motd", type: "string", value: "caf\u00e9" };
      rejects(b, registry(smallDefs()), "type", "g_motd");
    });
  });
});
