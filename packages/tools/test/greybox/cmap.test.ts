import {
  boxPlanes,
  buildBrush,
  buildCollisionWorld,
  CMAP_HASH_OFFSET,
  CMAP_PREAMBLE_BYTES,
  CMAP_SECTION_ENTRY_BYTES,
  CMAP_TAG_BRUSHES,
  CMAP_TAG_INDICES,
  CMAP_TAG_PLANE_SURFACES,
  CMAP_TAG_PLANES,
  CMAP_TAG_SURFACES,
  CMAP_TAG_VERTICES,
  type Cmap,
  type CmapData,
  type CmapEntity,
  CmapError,
  CONTENTS_LADDER,
  CONTENTS_PLAYERCLIP,
  CONTENTS_SOLID,
  CONTENTS_TRIGGER,
  type CollisionWorld,
  canonicalJson,
  cmapContentHash,
  cmapHashHex,
  cmapTag,
  createCollisionWorld,
  decodeCmap,
  FOOTSTEP_CONCRETE,
  FOOTSTEP_METAL,
  MASK_PLAYERSOLID,
  Mulberry32,
  rotatedBoxPlanes,
  SURF_LADDER,
  surfaceWithFootstep,
  TraceResult,
  traceBox,
  vec3,
  wedgePlanes,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { encodeCmap } from "../../src/greybox/cmapEncode";

// M1 design E: encodeCmap and decodeCmap are exact inverses, the hash covers every byte but its
// own, and the decoder refuses every malformed file with a CmapError.

const MATERIALS = ["grey/floor", "grey/wall", "tool/clip"];

/** Three brushes (box, box rotated 30° about Z, wedge), two render surfaces, three entities. */
function sample(): CmapData {
  const specs = [
    { built: buildBrush(boxPlanes([-512, -512, -16], [512, 512, 0])), contents: CONTENTS_SOLID },
    {
      built: buildBrush(rotatedBoxPlanes([100, 40, 112], [256, 8, 128], Math.sqrt(3) / 2, 0.5)),
      contents: CONTENTS_SOLID | CONTENTS_LADDER,
    },
    {
      built: buildBrush(wedgePlanes([0, -64, 0], [128, 64, 96], "+y")),
      contents: CONTENTS_PLAYERCLIP,
    },
  ];
  const planes: number[] = [];
  const surf: number[] = [];
  const material: number[] = [];
  const firstPlane: number[] = [];
  const planeCount: number[] = [];
  const bounds: number[] = [];
  specs.forEach(({ built }, i) => {
    const count = built.planes.length / 4;
    firstPlane.push(planes.length / 4);
    planeCount.push(count);
    planes.push(...built.planes);
    bounds.push(...built.bounds);
    for (let p = 0; p < count; p++) {
      const face = p < built.faceCount;
      material.push(face ? (i === 2 ? 2 : p % 2) : -1);
      surf.push(
        !face
          ? 0
          : i === 1
            ? SURF_LADDER
            : surfaceWithFootstep(0, p % 2 ? FOOTSTEP_METAL : FOOTSTEP_CONCRETE),
      );
    }
  });
  const entities: CmapEntity[] = [
    { classname: "info_player_start", origin: [0, 0, 24], angles: [0, 90, 0], props: {} },
    { classname: "info_target", origin: [-0.5, 1e-7, -16384], props: { b: "1", "10": "x", a: "" } },
    {
      classname: "trigger_timer",
      props: { name: "café ☕ \u{1f600}", note: 'quote" back\\ tab\t' },
      brushes: [2, 0],
    },
  ];
  // Surface 0: a quad of material 0; surface 1: a triangle of material 1. Indices are local.
  const vertices = Float32Array.from([
    ...[-512, -512, 0, 0, 0, 1, 0, 0],
    ...[512, -512, 0, 0, 0, 1, 8, 0],
    ...[512, 512, 0, 0, 0, 1, 8, 8],
    ...[-512, 512, 0, 0, 0, 1, 0, 8],
    ...[0, 0, 0, 0.6, 0, 0.8, 0.25, 0.5],
    ...[1, 0, 0, 0.6, 0, 0.8, 0.75, 0.5],
    ...[0, 1, 0, 0.6, 0, 0.8, 0.5, 1],
  ]);
  return {
    name: "cmap_unit_test",
    // The union of the brush bounds: the box's x and y, the rotated box's z.
    bounds: { mins: [-512, -512, -16], maxs: [512, 512, 240] },
    compiler: { name: "greybox", version: 1 },
    entities,
    materials: MATERIALS,
    units: "inch",
    up: "z",
    planes: Float32Array.from(planes),
    planeSurfaceFlags: Uint32Array.from(surf),
    planeMaterial: Int32Array.from(material),
    brushes: {
      firstPlane: Uint32Array.from(firstPlane),
      planeCount: Uint32Array.from(planeCount),
      faceCount: Uint32Array.from(specs.map((s) => s.built.faceCount)),
      contents: Uint32Array.from(specs.map((s) => s.contents)),
      bounds: Float32Array.from(bounds),
    },
    surfaces: {
      material: Uint32Array.of(0, 1),
      firstVertex: Uint32Array.of(0, 4),
      vertexCount: Uint32Array.of(4, 3),
      firstIndex: Uint32Array.of(0, 6),
      indexCount: Uint32Array.of(6, 3),
    },
    vertices,
    indices: Uint32Array.of(0, 1, 2, 0, 2, 3, 0, 1, 2),
  };
}

function withHash(data: CmapData, bytes: Uint8Array): Cmap {
  return { ...data, contentHash: cmapHashHex(cmapContentHash(bytes)) };
}

// Byte-level surgery for files the encoder would never write.

interface Section {
  tag: number;
  count: number;
  payload: Uint8Array;
}

interface Parts {
  json: string;
  sections: Section[];
}

function disassemble(bytes: Uint8Array): Parts {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(12, true);
  const tableEnd = CMAP_PREAMBLE_BYTES + CMAP_SECTION_ENTRY_BYTES * count;
  const json = String.fromCharCode(...bytes.subarray(tableEnd, tableEnd + view.getUint32(8, true)));
  const sections: Section[] = [];
  for (let s = 0; s < count; s++) {
    const at = CMAP_PREAMBLE_BYTES + CMAP_SECTION_ENTRY_BYTES * s;
    const offset = view.getUint32(at + 4, true);
    sections.push({
      tag: view.getUint32(at, true),
      count: view.getUint32(at + 12, true),
      payload: bytes.slice(offset, offset + view.getUint32(at + 8, true)),
    });
  }
  return { json: json.trimEnd(), sections };
}

/** A well-formed file from parts, with a valid hash (the layout encodeCmap writes). */
function assemble({ json, sections }: Parts): Uint8Array {
  const align = (n: number) => Math.ceil(n / 8) * 8;
  const tableEnd = CMAP_PREAMBLE_BYTES + CMAP_SECTION_ENTRY_BYTES * sections.length;
  const jsonLength = align(json.length);
  let cursor = tableEnd + jsonLength;
  const offsets = sections.map((s) => {
    const offset = cursor;
    cursor = align(cursor + s.payload.length);
    return offset;
  });
  const bytes = new Uint8Array(cursor);
  const view = new DataView(bytes.buffer);
  bytes.set([0x43, 0x4d, 0x41, 0x50]);
  view.setUint32(4, 1, true);
  view.setUint32(8, jsonLength, true);
  view.setUint32(12, sections.length, true);
  view.setUint32(24, cursor, true);
  sections.forEach((s, k) => {
    const at = CMAP_PREAMBLE_BYTES + CMAP_SECTION_ENTRY_BYTES * k;
    view.setUint32(at, s.tag, true);
    view.setUint32(at + 4, offsets[k] ?? 0, true);
    view.setUint32(at + 8, s.payload.length, true);
    view.setUint32(at + 12, s.count, true);
    bytes.set(s.payload, offsets[k] ?? 0);
  });
  for (let i = 0; i < jsonLength; i++)
    bytes[tableEnd + i] = i < json.length ? json.charCodeAt(i) : 0x20;
  return restamp(bytes);
}

/** Rewrites the hash field to match, so a test reaches the check it aims at. */
function restamp(bytes: Uint8Array): Uint8Array {
  const hash = cmapContentHash(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(CMAP_HASH_OFFSET, hash.lo, true);
  view.setUint32(CMAP_HASH_OFFSET + 4, hash.hi, true);
  return bytes;
}

function u32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(offset, value, true);
  return copy;
}

const ENTRY = (s: number, field: number) =>
  CMAP_PREAMBLE_BYTES + CMAP_SECTION_ENTRY_BYTES * s + 4 * field;
const TAG = 0;
const OFFSET = 1;
const BYTE_LENGTH = 2;
const COUNT = 3;

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true);
}

/** Section index of `tag` in an encodeCmap file. */
function sectionIndex(bytes: Uint8Array, tag: number): number {
  for (let s = 0; ; s++) if (readU32(bytes, ENTRY(s, TAG)) === tag) return s;
}

function withJson(bytes: Uint8Array, edit: (root: Record<string, unknown>) => void): Uint8Array {
  const parts = disassemble(bytes);
  const root = JSON.parse(parts.json) as Record<string, unknown>;
  edit(root);
  return assemble({ ...parts, json: canonicalJson(root) });
}

function entityOf(root: Record<string, unknown>, i: number): Record<string, unknown> {
  return (root.entities as Record<string, unknown>[])[i] as Record<string, unknown>;
}

/** A copy `extra` zero bytes longer, totalByteLength updated; the hash is left stale. */
function grown(bytes: Uint8Array, extra: number): Uint8Array {
  const copy = new Uint8Array(bytes.length + extra);
  copy.set(bytes);
  new DataView(copy.buffer).setUint32(24, copy.length, true);
  return copy;
}

/** BYTES with a 5-byte unknown XTRA section inserted at table position `at`. */
function withExtraSection(at: number): Uint8Array {
  const parts = disassemble(BYTES);
  const payload = Uint8Array.of(1, 2, 3, 4, 5);
  parts.sections.splice(at, 0, { tag: cmapTag("XTRA"), count: 99, payload });
  return assemble(parts);
}

function withJsonText(bytes: Uint8Array, json: string): Uint8Array {
  return assemble({ ...disassemble(bytes), json });
}

/** Encodes `sample()` after `edit` changes a copy of it: for invalid content the encoder lays out. */
function encodeEdited(edit: (d: Mutable) => void): Uint8Array {
  const d = sample() as Mutable;
  edit(d);
  return encodeCmap(d);
}

type Mutable = { -readonly [K in keyof CmapData]: CmapData[K] };

const BYTES = encodeCmap(sample());

function expectCmapError(bytes: Uint8Array, message: RegExp, verifyHash = true): void {
  let error: unknown;
  try {
    decodeCmap(bytes, { verifyHash });
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(CmapError);
  expect((error as Error).message).toMatch(message);
}

describe("encodeCmap / decodeCmap round trip", () => {
  it("decode(encode(x)) equals x", () => {
    const data = sample();
    expect(decodeCmap(BYTES)).toEqual(withHash(data, BYTES));
  });

  it("encodes byte-identically twice, and decode → encode reproduces the file", () => {
    expect(encodeCmap(sample())).toEqual(BYTES);
    expect(encodeCmap(decodeCmap(BYTES))).toEqual(BYTES);
  });

  it("keeps f32 bits exactly, including -0 and subnormals", () => {
    const bytes = encodeEdited((d) => {
      d.vertices = d.vertices.slice();
      d.vertices[3] = -0;
      d.vertices[6] = 1e-45;
      d.vertices[7] = 3.4028234663852886e38;
    });
    const v = decodeCmap(bytes).vertices;
    expect(Object.is(v[3], -0)).toBe(true);
    expect(v[6]).toBe(Math.fround(1e-45));
    expect(v[7]).toBe(3.4028234663852886e38);
  });

  it("writes the documented layout", () => {
    const view = new DataView(BYTES.buffer);
    expect(String.fromCharCode(...BYTES.subarray(0, 4))).toBe("CMAP");
    expect(view.getUint32(4, true)).toBe(1);
    expect(view.getUint32(12, true)).toBe(6);
    expect(view.getUint32(24, true)).toBe(BYTES.length);
    expect(view.getUint32(28, true)).toBe(0);
    expect(BYTES.length % 8).toBe(0);
    const tags = [0, 1, 2, 3, 4, 5].map((s) => readU32(BYTES, ENTRY(s, TAG)));
    expect(tags).toEqual([
      CMAP_TAG_PLANES,
      CMAP_TAG_PLANE_SURFACES,
      CMAP_TAG_BRUSHES,
      CMAP_TAG_SURFACES,
      CMAP_TAG_VERTICES,
      CMAP_TAG_INDICES,
    ]);
    expect(CMAP_TAG_PLANES).toBe(cmapTag("PLNS"));
    expect(String.fromCharCode(...BYTES.subarray(ENTRY(0, TAG), ENTRY(0, TAG) + 4))).toBe("PLNS");
    const sizes = [16, 8, 40, 24, 32, 4];
    const jsonStart = CMAP_PREAMBLE_BYTES + 6 * CMAP_SECTION_ENTRY_BYTES;
    let expectedOffset = jsonStart + view.getUint32(8, true);
    for (let s = 0; s < 6; s++) {
      const offset = readU32(BYTES, ENTRY(s, OFFSET));
      expect(offset).toBe(expectedOffset);
      expect(readU32(BYTES, ENTRY(s, BYTE_LENGTH))).toBe(
        readU32(BYTES, ENTRY(s, COUNT)) * (sizes[s] ?? 0),
      );
      expectedOffset = Math.ceil((offset + readU32(BYTES, ENTRY(s, BYTE_LENGTH))) / 8) * 8;
    }
    expect(expectedOffset).toBe(BYTES.length);
  });

  it("writes canonical, printable-ASCII JSON padded with spaces", () => {
    const { json } = disassemble(BYTES);
    const jsonLength = new DataView(BYTES.buffer).getUint32(8, true);
    const start = CMAP_PREAMBLE_BYTES + 6 * CMAP_SECTION_ENTRY_BYTES;
    const padded = String.fromCharCode(...BYTES.subarray(start, start + jsonLength));
    expect(jsonLength % 8).toBe(0);
    expect(padded).toBe(json.padEnd(jsonLength, " "));
    expect(json).toMatch(/^[\x20-\x7e]*$/);
    expect(json.startsWith('{"bounds":{"maxs":[512,512,240],"mins":[-512,-512,-16]},')).toBe(true);
    expect(json).toContain('"props":{"10":"x","a":"","b":"1"}');
    expect(json).toContain('"origin":[-0.5,1e-7,-16384]');
    expect(json).toContain("caf\\u00e9 \\u2615 \\ud83d\\ude00");
    expect(json.endsWith('"name":"cmap_unit_test","units":"inch","up":"z"}')).toBe(true);
  });

  it("decodes from a view into a larger buffer", () => {
    const big = new Uint8Array(BYTES.length + 13);
    big.set(BYTES, 5);
    expect(decodeCmap(big.subarray(5, 5 + BYTES.length))).toEqual(decodeCmap(BYTES));
  });

  it("decodes a Node Buffer twice without modifying it", () => {
    const buffer = Buffer.from(BYTES);
    expect(decodeCmap(buffer)).toEqual(decodeCmap(BYTES));
    expect(decodeCmap(buffer)).toEqual(decodeCmap(BYTES));
    expect(cmapContentHash(buffer)).toEqual(cmapContentHash(BYTES));
    expect(new Uint8Array(buffer)).toEqual(BYTES);
  });

  // Prefix lengths shift where the 4096-byte chunk boundaries fall inside the \uXXXX escapes.
  it.each([0, 1, 2, 3, 4, 5])("round-trips JSON over two 4096-byte chunks (shift %i)", (shift) => {
    const data = sample() as Mutable;
    data.entities = [
      ...data.entities,
      { classname: "info_note", props: { text: `${"x".repeat(shift)}${"é☕".repeat(1500)}` } },
    ];
    const bytes = encodeCmap(data);
    expect(readU32(bytes, 8)).toBeGreaterThan(2 * 4096);
    expect(decodeCmap(bytes)).toEqual(withHash(data, bytes));
  });

  const shorten = <T extends { slice(start: number): T }>(a: T): T => a.slice(1);
  const lengthEdits: readonly (readonly [string, (d: Mutable) => void, RegExp])[] = [
    ["planes", (d) => (d.planes = shorten(d.planes)), /plane floats is not 4·n/],
    [
      "planeSurfaceFlags",
      (d) => (d.planeSurfaceFlags = shorten(d.planeSurfaceFlags)),
      /planeSurfaceFlags has/,
    ],
    ["planeMaterial", (d) => (d.planeMaterial = shorten(d.planeMaterial)), /planeMaterial has/],
    [
      "brushes.planeCount",
      (d) => (d.brushes = { ...d.brushes, planeCount: shorten(d.brushes.planeCount) }),
      /brushes\.planeCount has/,
    ],
    [
      "brushes.faceCount",
      (d) => (d.brushes = { ...d.brushes, faceCount: shorten(d.brushes.faceCount) }),
      /brushes\.faceCount has/,
    ],
    [
      "brushes.contents",
      (d) => (d.brushes = { ...d.brushes, contents: shorten(d.brushes.contents) }),
      /brushes\.contents has/,
    ],
    [
      "brushes.bounds",
      (d) => (d.brushes = { ...d.brushes, bounds: shorten(d.brushes.bounds) }),
      /brushes\.bounds has/,
    ],
    [
      "surfaces.firstVertex",
      (d) => (d.surfaces = { ...d.surfaces, firstVertex: shorten(d.surfaces.firstVertex) }),
      /surfaces\.firstVertex has/,
    ],
    [
      "surfaces.vertexCount",
      (d) => (d.surfaces = { ...d.surfaces, vertexCount: shorten(d.surfaces.vertexCount) }),
      /surfaces\.vertexCount has/,
    ],
    [
      "surfaces.firstIndex",
      (d) => (d.surfaces = { ...d.surfaces, firstIndex: shorten(d.surfaces.firstIndex) }),
      /surfaces\.firstIndex has/,
    ],
    [
      "surfaces.indexCount",
      (d) => (d.surfaces = { ...d.surfaces, indexCount: shorten(d.surfaces.indexCount) }),
      /surfaces\.indexCount has/,
    ],
    ["vertices", (d) => (d.vertices = shorten(d.vertices)), /vertex floats is not 8·n/],
  ];

  it.each(lengthEdits)("refuses a short %s array", (_name, edit, message) => {
    let error: unknown;
    try {
      encodeEdited(edit);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CmapError);
    expect((error as Error).message).toMatch(message);
  });

  it("refuses non-finite JSON values", () => {
    expect(() =>
      encodeEdited((d) => (d.bounds = { mins: [Number.NaN, 0, 0], maxs: [0, 0, 0] })),
    ).toThrow(TypeError);
  });
});

describe("contentHash", () => {
  const original = cmapContentHash(BYTES);

  it("is 16 lowercase hex digits, high lane first", () => {
    const hex = decodeCmap(BYTES).contentHash;
    expect(hex).toMatch(/^[0-9a-f]{16}$/);
    expect(hex).toBe(
      original.hi.toString(16).padStart(8, "0") + original.lo.toString(16).padStart(8, "0"),
    );
    expect(readU32(BYTES, CMAP_HASH_OFFSET)).toBe(original.lo);
    expect(readU32(BYTES, CMAP_HASH_OFFSET + 4)).toBe(original.hi);
  });

  it("changes with every byte outside the hash field, and the decoder then refuses the file", () => {
    // Every position: preamble, table, JSON and its padding, sections and theirs.
    for (let i = 0; i < BYTES.length; i++) {
      if (i >= CMAP_HASH_OFFSET && i < CMAP_HASH_OFFSET + 8) continue;
      for (const flip of [0x01, 0x80]) {
        const corrupt = BYTES.slice();
        corrupt[i] = (corrupt[i] as number) ^ flip;
        const h = cmapContentHash(corrupt);
        expect(h.lo === original.lo || h.hi === original.hi, `byte ${i} ^ ${flip}`).toBe(false);
        expect(() => decodeCmap(corrupt), `byte ${i} ^ ${flip}`).toThrow(CmapError);
      }
    }
  });

  it("ignores its own field, and a wrong value fails only with verifyHash", () => {
    for (let i = CMAP_HASH_OFFSET; i < CMAP_HASH_OFFSET + 8; i++) {
      const corrupt = BYTES.slice();
      corrupt[i] = (corrupt[i] as number) ^ 0x10;
      expect(cmapContentHash(corrupt)).toEqual(original);
      expectCmapError(corrupt, /contentHash mismatch/);
      const unchecked = decodeCmap(corrupt, { verifyHash: false });
      expect(unchecked.contentHash).not.toBe(decodeCmap(BYTES).contentHash);
      expect({ ...unchecked, contentHash: "" }).toEqual({ ...decodeCmap(BYTES), contentHash: "" });
    }
  });
});

describe("decodeCmap ignores unknown sections", () => {
  it.each([0, 3, 6])("with one inserted at table position %i", (at) => {
    const bytes = withExtraSection(at);
    expect(readU32(bytes, 12)).toBe(7);
    expect({ ...decodeCmap(bytes), contentHash: "" }).toEqual({
      ...decodeCmap(BYTES),
      contentHash: "",
    });
  });

  it("and the reassembly helper reproduces encodeCmap's bytes", () => {
    expect(assemble(disassemble(BYTES))).toEqual(BYTES);
  });
});

const planes = sectionIndex(BYTES, CMAP_TAG_PLANES);
const planeSurf = sectionIndex(BYTES, CMAP_TAG_PLANE_SURFACES);
const brushes = sectionIndex(BYTES, CMAP_TAG_BRUSHES);
const surfaces = sectionIndex(BYTES, CMAP_TAG_SURFACES);
const vertices = sectionIndex(BYTES, CMAP_TAG_VERTICES);
const indices = sectionIndex(BYTES, CMAP_TAG_INDICES);
const field = (s: number, f: number) => readU32(BYTES, ENTRY(s, f));
const lastBrush = sample().brushes.firstPlane.length - 1;
const planeTotal = sample().planes.length / 4;
const brushRecord = (i: number, f: number) => field(brushes, OFFSET) + 40 * i + 4 * f;
const surfaceRecord = (i: number, f: number) => field(surfaces, OFFSET) + 24 * i + 4 * f;

function editSection(tag: number, edit: (payload: DataView) => void): Uint8Array {
  const parts = disassemble(BYTES);
  const section = parts.sections.find((s) => s.tag === tag) as Section;
  edit(new DataView(section.payload.buffer));
  return assemble(parts);
}

function face(d: Mutable, brush: number, plane: number, material: number): void {
  d.planeMaterial = d.planeMaterial.slice();
  d.planeMaterial[(d.brushes.firstPlane[brush] as number) + plane] = material;
}

/** JSON that parses to the sample's metadata but is not the text canonicalJson writes for it. */
function nonCanonicalJson(): (readonly [string, () => Uint8Array, RegExp])[] {
  const json = disassemble(BYTES).json;
  const variant = (from: string, to: string) => () => {
    expect(json).toContain(from);
    return withJsonText(BYTES, json.replace(from, to));
  };
  const notCanonical = /JSON is not canonical \(docs\/07 §2\): it differs at character \d+/;
  return [
    ["JSON with inner whitespace", variant('"units":', '"units" :'), notCanonical],
    [
      "JSON with keys out of order",
      variant('"units":"inch","up":"z"', '"up":"z","units":"inch"'),
      notCanonical,
    ],
    [
      "JSON with a duplicate key",
      variant('"name":"cmap_unit_test"', '"name":"x","name":"cmap_unit_test"'),
      notCanonical,
    ],
    [
      "JSON with a needless escape",
      variant('"cmap_unit_test"', '"cmap_unit_tes\\u0074"'),
      notCanonical,
    ],
    [
      "JSON with a raw DEL character",
      variant('"cmap_unit_test"', '"cmap_unit_test\x7f"'),
      notCanonical,
    ],
    ["JSON with another number spelling", variant('"version":1', '"version":1.0e0'), notCanonical],
    ["JSON with -0", variant("[0,0,24]", "[-0,0,24]"), notCanonical],
  ];
}

const rejections: readonly (readonly [string, () => Uint8Array, RegExp])[] = [
  ["a file shorter than the preamble", () => BYTES.slice(0, 31), /shorter than the 32-byte/],
  ["bad magic", () => u32(BYTES, 0, cmapTag("CMAQ")), /bad magic/],
  ["another format version", () => u32(BYTES, 4, 2), /format version 2/],
  ["a truncated file", () => BYTES.slice(0, BYTES.length - 8), /totalByteLength says/],
  ["a wrong totalByteLength", () => u32(BYTES, 24, BYTES.length + 8), /totalByteLength says/],
  ["a non-zero reserved word", () => u32(BYTES, 28, 1), /reserved preamble word/],
  ["a section table past the end", () => u32(BYTES, 12, 0x10000000), /section table/],
  [
    "an unaligned jsonByteLength",
    () => u32(BYTES, 8, readU32(BYTES, 8) + 4),
    /not a multiple of 8/,
  ],
  ["JSON past the end", () => u32(BYTES, 8, BYTES.length), /JSON .* runs past the end/],
  [
    "an unaligned section offset",
    () => u32(BYTES, ENTRY(vertices, OFFSET), field(vertices, OFFSET) + 4),
    /offset \d+ is not 8-aligned/,
  ],
  [
    "a section past the end of the file",
    () => u32(BYTES, ENTRY(indices, OFFSET), BYTES.length),
    /IDXS\): runs past the end/,
  ],
  [
    "a section overlapping the header",
    () => u32(BYTES, ENTRY(planes, OFFSET), CMAP_PREAMBLE_BYTES + 8),
    /overlaps the preamble, section table or JSON/,
  ],
  [
    "a section starting before the end of the previous one",
    () => u32(BYTES, ENTRY(planeSurf, OFFSET), field(planes, OFFSET)),
    /PLSF\): starts before the end of the previous section/,
  ],
  [
    "a gap between sections",
    () => {
      const b = grown(BYTES, 8);
      return restamp(u32(b, ENTRY(indices, OFFSET), field(indices, OFFSET) + 8));
    },
    /IDXS\): leaves a gap after the previous data/,
  ],
  [
    "a gap between the JSON and the first section",
    () => {
      const parts = disassemble(BYTES);
      const bytes = grown(assemble(parts), 8);
      for (let s = 0; s < parts.sections.length; s++) {
        new DataView(bytes.buffer).setUint32(ENTRY(s, OFFSET), field(s, OFFSET) + 8, true);
      }
      return restamp(bytes);
    },
    /PLNS\): leaves a gap after the previous data/,
  ],
  [
    "non-zero padding between sections",
    () => {
      const bytes = withExtraSection(3);
      const at = readU32(bytes, ENTRY(3, OFFSET)) + 5;
      bytes[at] = 0x7f;
      return restamp(bytes);
    },
    /padding byte at offset \d+ is not 0/,
  ],
  [
    "non-zero padding after the last section",
    () => {
      const bytes = BYTES.slice();
      bytes[bytes.length - 1] = 1;
      return restamp(bytes);
    },
    new RegExp(`padding byte at offset ${BYTES.length - 1} is not 0`),
  ],
  [
    "bytes after the last section",
    () => restamp(grown(BYTES, 8)),
    /8 bytes after the last section's padding/,
  ],
  [
    "JSON padded with 8 spaces or more",
    () => withJsonText(BYTES, `${disassemble(BYTES).json}        `),
    /JSON padding is \d+ spaces, not under 8/,
  ],
  [
    "JSON with leading whitespace",
    () => withJsonText(BYTES, ` ${disassemble(BYTES).json}`),
    /JSON starts with whitespace/,
  ],
  [
    "JSON with trailing whitespace other than spaces",
    () => withJsonText(BYTES, `${disassemble(BYTES).json}\n`),
    /JSON ends with whitespace other than the space padding/,
  ],
  [
    "a byteLength that is not count × record size",
    () => u32(BYTES, ENTRY(brushes, COUNT), field(brushes, COUNT) + 1),
    /BRSH\): \d+ bytes for \d+ records of 40 bytes/,
  ],
  [
    "a known section twice",
    () => {
      const b = u32(BYTES, ENTRY(vertices, TAG), CMAP_TAG_INDICES);
      return u32(b, ENTRY(vertices, COUNT), field(vertices, BYTE_LENGTH) / 4);
    },
    /IDXS\): appears twice/,
  ],
  [
    "a missing required section",
    () => u32(BYTES, ENTRY(surfaces, TAG), cmapTag("ZZZZ")),
    /required section SURF is missing/,
  ],
  [
    "a non-ASCII JSON byte",
    () => withJsonText(BYTES, disassemble(BYTES).json.replace("grey/floor", "grey/flöor")),
    /JSON byte \d+ is not ASCII/,
  ],
  ["JSON that does not parse", () => withJsonText(BYTES, '{"bounds":'), /JSON does not parse/],
  ["JSON that is not an object", () => withJsonText(BYTES, "[]"), /JSON must be an object/],
  [
    "a missing JSON key",
    () => withJson(BYTES, (r) => delete r.materials),
    /JSON: missing key "materials"/,
  ],
  ["an unknown JSON key", () => withJson(BYTES, (r) => (r.extra = 1)), /JSON: unknown key "extra"/],
  [
    "a JSON value of the wrong type",
    () => withJson(BYTES, (r) => (r.name = 5)),
    /name must be a string/,
  ],
  [
    "an entity prop that is not a string",
    () =>
      withJson(BYTES, (r) => ((r.entities as unknown[])[0] = { classname: "x", props: { a: 1 } })),
    /entities\[0\]\.props\["a"\] must be a string/,
  ],
  [
    "a non-finite JSON number",
    () => withJsonText(BYTES, disassemble(BYTES).json.replace("[0,0,24]", "[0,0,1e999]")),
    /entities\[0\]\.origin\[2\] must be a finite number/,
  ],
  [
    "a JSON vector of the wrong length",
    () => withJsonText(BYTES, disassemble(BYTES).json.replace("[0,0,24]", "[0,0]")),
    /entities\[0\]\.origin must have 3 numbers/,
  ],
  [
    "inverted JSON bounds",
    () => withJson(BYTES, (r) => (r.bounds = { mins: [0, 0, 1], maxs: [0, 0, 0] })),
    /bounds: mins > maxs on axis 2/,
  ],
  [
    "a bad compiler version",
    () => withJson(BYTES, (r) => (r.compiler = { name: "greybox", version: 1.5 })),
    /compiler\.version must be a non-negative integer/,
  ],
  [
    "a negative compiler version",
    () => withJson(BYTES, (r) => (r.compiler = { name: "greybox", version: -1 })),
    /compiler\.version must be a non-negative integer/,
  ],
  [
    "an unknown compiler key",
    () => withJson(BYTES, (r) => (r.compiler = { name: "greybox", version: 1, extra: 0 })),
    /compiler: unknown key "extra"/,
  ],
  [
    "an unknown bounds key",
    () => withJson(BYTES, (r) => ((r.bounds as Record<string, unknown>).extra = 0)),
    /bounds: unknown key "extra"/,
  ],
  [
    "an unknown entity key",
    () => withJson(BYTES, (r) => (entityOf(r, 0).extra = 0)),
    /entities\[0\]: unknown key "extra"/,
  ],
  [
    "entity props that are not an object",
    () => withJson(BYTES, (r) => (entityOf(r, 0).props = [])),
    /entities\[0\]\.props must be an object/,
  ],
  [
    "a non-finite entity angle",
    () => withJsonText(BYTES, disassemble(BYTES).json.replace("[0,90,0]", "[0,90,1e999]")),
    /entities\[0\]\.angles\[2\] must be a finite number/,
  ],
  [
    "entity angles of the wrong length",
    () => withJsonText(BYTES, disassemble(BYTES).json.replace("[0,90,0]", "[0,90]")),
    /entities\[0\]\.angles must have 3 numbers, not 2/,
  ],
  ["an empty name", () => withJson(BYTES, (r) => (r.name = "")), /^name must not be empty/],
  [
    "an empty classname",
    () => withJson(BYTES, (r) => (entityOf(r, 1).classname = "")),
    /entities\[1\]\.classname must not be empty/,
  ],
  [
    "an empty material name",
    () => withJson(BYTES, (r) => ((r.materials as string[])[1] = "")),
    /materials\[1\] must not be empty/,
  ],
  ["other units", () => withJson(BYTES, (r) => (r.units = "cm")), /units must be "inch"/],
  ["another up axis", () => withJson(BYTES, (r) => (r.up = "y")), /up must be "z"/],
  [
    "an entity brush index out of range",
    () =>
      encodeEdited((d) => {
        d.entities = [{ classname: "trigger_timer", props: {}, brushes: [3] }];
      }),
    /entities\[0\]\.brushes\[0\] must be a brush index in 0…2/,
  ],
  [
    "a negative entity brush index",
    () => withJson(BYTES, (r) => (entityOf(r, 2).brushes = [0, -1])),
    /entities\[2\]\.brushes\[1\] must be a brush index in 0…2/,
  ],
  [
    "a fractional entity brush index",
    () => withJson(BYTES, (r) => (entityOf(r, 2).brushes = [0.5])),
    /entities\[2\]\.brushes\[0\] must be a brush index in 0…2/,
  ],
  [
    "a PLSF count that differs from PLNS",
    () => {
      const parts = disassemble(BYTES);
      const plsf = parts.sections[planeSurf] as Section;
      plsf.count = planeTotal - 1;
      plsf.payload = plsf.payload.slice(0, 8 * (planeTotal - 1));
      return assemble(parts);
    },
    /PLSF has \d+ records for \d+ planes/,
  ],
  [
    "a non-finite plane value",
    () => encodeEdited((d) => (d.planes = d.planes.map((v, i) => (i === 9 ? Number.NaN : v)))),
    /PLNS value 9 \(record 2\) is not finite/,
  ],
  [
    "a non-finite brush bound",
    () =>
      encodeEdited((d) => {
        d.brushes = {
          ...d.brushes,
          bounds: d.brushes.bounds.map((v, i) => (i === 7 ? Infinity : v)),
        };
      }),
    /brush 1: bounds value 1 is not finite/,
  ],
  [
    "a non-finite vertex value",
    () => encodeEdited((d) => (d.vertices = d.vertices.map((v, i) => (i === 21 ? -Infinity : v)))),
    /VTXS value 21 \(record 2\) is not finite/,
  ],
  [
    "brushes out of plane order",
    () => u32(BYTES, brushRecord(1, 0), readU32(BYTES, brushRecord(1, 0)) + 1),
    /brush 1: firstPlane \d+, expected \d+/,
  ],
  [
    "brush planes past the plane list",
    () => u32(BYTES, brushRecord(lastBrush, 1), readU32(BYTES, brushRecord(lastBrush, 1)) + 1),
    /brush 2: planes \d+\+\d+ past \d+/,
  ],
  [
    "planes no brush uses",
    () => u32(BYTES, brushRecord(lastBrush, 1), readU32(BYTES, brushRecord(lastBrush, 1)) - 1),
    /brushes use \d+ of the \d+ planes/,
  ],
  [
    "a planeCount below 4",
    () => u32(BYTES, brushRecord(lastBrush, 1), 3),
    /planeCount 3 is below 4/,
  ],
  [
    "a faceCount above planeCount",
    () => u32(BYTES, brushRecord(0, 2), readU32(BYTES, brushRecord(0, 1)) + 1),
    /brush 0: faceCount \d+ exceeds planeCount/,
  ],
  [
    "a faceCount below 4",
    () => u32(BYTES, brushRecord(0, 2), 3),
    /brush 0: faceCount 3 is below 4/,
  ],
  ["unknown contents bits", () => u32(BYTES, brushRecord(1, 3), 0x101), /contents 0x101 must be/],
  ["empty contents", () => u32(BYTES, brushRecord(1, 3), 0), /contents 0x0 must be/],
  [
    "a face without a material",
    () => encodeEdited((d) => face(d, 1, 0, -1)),
    /plane \d+ \(brush 1 face\): material -1, expected 0…2/,
  ],
  [
    "a face material past the list",
    () => encodeEdited((d) => face(d, 0, 2, 3)),
    /plane 2 \(brush 0 face\): material 3, expected 0…2/,
  ],
  [
    "a bevel with a material",
    () => encodeEdited((d) => face(d, 1, (d.brushes.planeCount[1] as number) - 1, 0)),
    /\(brush 1 bevel\): material 0, expected -1/,
  ],
  [
    "brush bounds that are not its axial planes",
    () =>
      encodeEdited((d) => {
        d.brushes = { ...d.brushes, bounds: d.brushes.bounds.map((v, i) => (i === 0 ? v - 1 : v)) };
      }),
    /brush 0: bounds value 0 is not the distance of a −x plane/,
  ],
  [
    "unknown surface flag bits",
    () =>
      encodeEdited(
        (d) => (d.planeSurfaceFlags = d.planeSurfaceFlags.map((v, i) => (i === 1 ? 0x80 : v))),
      ),
    /brush 0: plane 1 surface flags 128 have unknown bits/,
  ],
  [
    "a non-unit plane normal",
    () => encodeEdited((d) => (d.planes = d.planes.map((v, i) => (i === 0 ? -0.5 : v)))),
    /brush 0: plane 0 normal is not unit length/,
  ],
  [
    "a surface material past the list",
    () => u32(BYTES, surfaceRecord(1, 0), 3),
    /surface 1: material 3 out of range/,
  ],
  [
    "surface vertices past the vertex list",
    () => u32(BYTES, surfaceRecord(1, 2), 4),
    /surface 1: vertices 4\+4 past 7/,
  ],
  [
    "surface indices past the index list",
    () => u32(BYTES, surfaceRecord(1, 4), 6),
    /surface 1: indices 6\+6 past 9/,
  ],
  [
    "an index count that is not triangles",
    () => u32(BYTES, surfaceRecord(0, 4), 5),
    /surface 0: indexCount 5 is not triangles/,
  ],
  [
    "an index past its surface's vertices",
    () => editSection(CMAP_TAG_INDICES, (v) => v.setUint32(4 * 7, 3, true)),
    /surface 1: index 7 is 3, past its 3 vertices/,
  ],
  [
    "an index past the vertex list",
    () => editSection(CMAP_TAG_INDICES, (v) => v.setUint32(4 * 2, 7, true)),
    /surface 0: index 2 is 7, past its 4 vertices/,
  ],
  [
    "a surface whose indices overlap the previous surface's",
    () => u32(BYTES, surfaceRecord(1, 3), 0),
    /surface 1: firstIndex 0, expected 6 \(surfaces tile IDXS\)/,
  ],
  [
    "a surface whose vertices overlap the previous surface's",
    () => u32(BYTES, surfaceRecord(1, 1), 0),
    /surface 1: firstVertex 0, expected 4 \(surfaces tile VTXS\)/,
  ],
  [
    "a gap between two surfaces' vertices",
    () => u32(u32(BYTES, surfaceRecord(1, 1), 5), surfaceRecord(1, 2), 2),
    /surface 1: firstVertex 5, expected 4/,
  ],
  [
    "a material repeated by the next surface",
    () => u32(BYTES, surfaceRecord(1, 0), 0),
    /surface 1: material 0 is not above the previous surface's/,
  ],
  [
    "surfaces out of material order",
    () => u32(u32(BYTES, surfaceRecord(0, 0), 2), surfaceRecord(1, 0), 1),
    /surface 1: material 1 is not above the previous surface's/,
  ],
  [
    "a surface with no triangles",
    () =>
      encodeEdited((d) => {
        d.surfaces = {
          material: Uint32Array.of(0, 1, 2),
          firstVertex: Uint32Array.of(0, 4, 7),
          vertexCount: Uint32Array.of(4, 3, 0),
          firstIndex: Uint32Array.of(0, 6, 9),
          indexCount: Uint32Array.of(6, 3, 0),
        };
      }),
    /surface 2: has no triangles/,
  ],
  [
    "vertices no surface covers",
    () =>
      encodeEdited((d) => {
        d.vertices = Float32Array.from([...d.vertices, 0, 0, 0, 0, 0, 1, 0, 0]);
      }),
    /surfaces cover 7 of the 8 vertices/,
  ],
  [
    "indices no surface covers",
    () => encodeEdited((d) => (d.indices = Uint32Array.from([...d.indices, 0, 0, 0]))),
    /surfaces cover 9 of the 12 indices/,
  ],
  [
    "JSON bounds that are not the union of the brush bounds",
    () => withJson(BYTES, (r) => (r.bounds = { mins: [0, 0, 0], maxs: [1, 1, 1] })),
    /bounds on axis 0 are \[0, 1\], the brushes span \[-512, 512\]/,
  ],
  [
    "JSON bounds that contain the brushes but are larger",
    () => withJson(BYTES, (r) => (r.bounds = { mins: [-512, -512, -16], maxs: [512, 512, 241] })),
    /bounds on axis 2 are \[-16, 241\], the brushes span \[-16, 240\]/,
  ],
  [
    "an entity origin outside the world limit",
    () => withJson(BYTES, (r) => (entityOf(r, 1).origin = [-0.5, 16384.5, 0])),
    /entities\[1\]\.origin\[1\] is outside the ±16384 u world limit/,
  ],
  [
    "an entity origin far outside the world limit",
    () => withJson(BYTES, (r) => (entityOf(r, 0).origin = [1e30, 0, 0])),
    /entities\[0\]\.origin\[0\] is outside the ±16384 u world limit/,
  ],
  ...nonCanonicalJson(),
  [
    "a non-zero surface reserved word",
    () => u32(BYTES, surfaceRecord(0, 5), 1),
    /surface 0: reserved word is not 0/,
  ],
  [
    "a hash mismatch",
    () => u32(BYTES, CMAP_HASH_OFFSET, readU32(BYTES, CMAP_HASH_OFFSET) ^ 1),
    /contentHash mismatch/,
  ],
];

describe("decodeCmap refuses", () => {
  it.each(rejections)("%s", (_name, make, message) => {
    const bytes = make();
    expectCmapError(bytes, message);
    // Validation comes before the hash check, so it does not depend on verifyHash.
    if (message.source !== "contentHash mismatch") expectCmapError(bytes, message, false);
  });

  it("the sample itself, so the cases above test one defect each", () => {
    expect(() => decodeCmap(BYTES)).not.toThrow();
  });
});

describe("buildCollisionWorld", () => {
  function directWorld(): CollisionWorld {
    const d = sample();
    const b = d.brushes;
    return createCollisionWorld(
      Array.from(b.firstPlane, (first, i) => {
        const end = first + (b.planeCount[i] as number);
        return {
          planes: d.planes.slice(4 * first, 4 * end),
          faceCount: b.faceCount[i] as number,
          bounds: b.bounds.slice(6 * i, 6 * i + 6),
          contents: b.contents[i] as number,
          surfaceFlags: d.planeSurfaceFlags.slice(first, end),
        };
      }),
    );
  }

  it("matches a CollisionWorld built directly from the same brushes", () => {
    const fromFile = buildCollisionWorld(decodeCmap(BYTES));
    const direct = directWorld();
    expect(fromFile).toEqual(direct);
    expect(fromFile.planes).toBeInstanceOf(Float64Array);
  });

  it("gives the same trace results, bit for bit", () => {
    const fromFile = buildCollisionWorld(decodeCmap(BYTES));
    const direct = directWorld();
    const rng = new Mulberry32(0xc3a9);
    const coord = (span: number) => (rng.nextFloat() * 2 - 1) * span;
    const a = new TraceResult();
    const b = new TraceResult();
    const start = vec3();
    const end = vec3();
    const mins = vec3(-16, -16, -24);
    const maxs = vec3(16, 16, 32);
    let hits = 0;
    for (let n = 0; n < 2000; n++) {
      start.set([coord(600), coord(600), coord(80) + 60]);
      end.set([coord(600), coord(600), coord(80) + 60]);
      traceBox(fromFile, start, end, mins, maxs, MASK_PLAYERSOLID | CONTENTS_TRIGGER, a);
      traceBox(direct, start, end, mins, maxs, MASK_PLAYERSOLID | CONTENTS_TRIGGER, b);
      expect(a).toEqual(b);
      if (a.fraction < 1) hits++;
    }
    expect(hits).toBeGreaterThan(200);
  });

  it("refuses a Cmap whose brushes break the collision rules, as a CmapError", () => {
    const d = sample() as Mutable;
    d.brushes = { ...d.brushes, contents: Uint32Array.of(1, 0x100, 2) };
    expect(() => buildCollisionWorld(d)).toThrow(CmapError);
  });

  it.each([
    [
      "planes",
      (d: Mutable) => (d.brushes = { ...d.brushes, planeCount: Uint32Array.of(6, 8, 99) }),
    ],
    ["planeSurfaceFlags", (d: Mutable) => (d.planeSurfaceFlags = d.planeSurfaceFlags.slice(1))],
    ["bounds", (d: Mutable) => (d.brushes = { ...d.brushes, bounds: d.brushes.bounds.slice(6) })],
  ])("refuses a brush record that points past the %s array", (_name, edit) => {
    const d = sample() as Mutable;
    edit(d);
    let error: unknown;
    try {
      buildCollisionWorld(d);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CmapError);
    expect((error as Error).message).toMatch(/brush 2: record points past the plane or bounds/);
  });
});
