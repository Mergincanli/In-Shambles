import { CMAP_HASH_OFFSET, cmapContentHash, cmapHashHex } from "./cmapHash";
import {
  type CollisionBrushSource,
  type CollisionWorld,
  CollisionWorldError,
  createCollisionWorld,
  validateCollisionBrush,
} from "./collisionWorld";
import { CONTENTS_KNOWN } from "./contents";

/**
 * The compiled map format, cmap v1 (docs/07 §2). One little-endian file:
 * - a 32-byte preamble: "CMAP", formatVersion, jsonByteLength, sectionCount, hashLo, hashHi,
 *   totalByteLength, reserved (all u32);
 * - the section table: sectionCount × {u32 fourcc tag, u32 offset, u32 byteLength, u32 count};
 * - canonical ASCII JSON metadata, padded with spaces to a multiple of 8 bytes;
 * - the binary sections in table order, each at the first 8-aligned offset after the previous
 *   one, with zero padding between them and after the last, which ends the file.
 * Geometry lives in the sections; the JSON holds metadata and strings only. The BVH is not stored:
 * buildCollisionWorld builds it at load time, deterministically.
 */

/** Bumped when the layout changes incompatibly. compiler.version tracks intended output changes. */
export const CMAP_FORMAT_VERSION = 1;
export const CMAP_MAGIC = "CMAP";
export const CMAP_PREAMBLE_BYTES = 32;
export const CMAP_SECTION_ENTRY_BYTES = 16;
/** Section offsets, the JSON length and the section padding are multiples of this. */
export const CMAP_ALIGN = 8;
/** Floats per vertex: position xyz, normal xyz, uv0. */
export const CMAP_VERTEX_FLOATS = 8;

/** A fourcc tag as the u32 the table stores (its four ASCII bytes read little-endian). */
export function cmapTag(text: string): number {
  return (
    (text.charCodeAt(0) |
      (text.charCodeAt(1) << 8) |
      (text.charCodeAt(2) << 16) |
      (text.charCodeAt(3) << 24)) >>>
    0
  );
}

/** f32 nx, ny, nz, d per plane: each brush's faces, then its bevels, brush by brush. */
export const CMAP_TAG_PLANES = cmapTag("PLNS");
/** Per plane: u32 surfaceFlags, i32 material (−1 for a bevel). */
export const CMAP_TAG_PLANE_SURFACES = cmapTag("PLSF");
/** Per brush: u32 firstPlane, planeCount, faceCount, contents; f32 bounds min xyz, max xyz. */
export const CMAP_TAG_BRUSHES = cmapTag("BRSH");
/** Per render surface: u32 material, firstVertex, vertexCount, firstIndex, indexCount, reserved. */
export const CMAP_TAG_SURFACES = cmapTag("SURF");
/** Per vertex: CMAP_VERTEX_FLOATS f32. */
export const CMAP_TAG_VERTICES = cmapTag("VTXS");
/** u32 triangle indices, relative to their surface's firstVertex. */
export const CMAP_TAG_INDICES = cmapTag("IDXS");

/** The known sections in file order, with their record sizes. Every one is required. */
export const CMAP_SECTIONS: readonly (readonly [tag: number, recordBytes: number])[] = [
  [CMAP_TAG_PLANES, 16],
  [CMAP_TAG_PLANE_SURFACES, 8],
  [CMAP_TAG_BRUSHES, 40],
  [CMAP_TAG_SURFACES, 24],
  [CMAP_TAG_VERTICES, 4 * CMAP_VERTEX_FLOATS],
  [CMAP_TAG_INDICES, 4],
];

export type CmapVec3 = readonly [number, number, number];

export interface CmapBounds {
  readonly mins: CmapVec3;
  readonly maxs: CmapVec3;
}

export interface CmapCompiler {
  readonly name: string;
  /** Bumped whenever compiler output changes on purpose, which explains a changed .cmap. */
  readonly version: number;
}

export interface CmapEntity {
  readonly classname: string;
  readonly origin?: CmapVec3;
  /** Pitch, yaw, roll in degrees. */
  readonly angles?: CmapVec3;
  readonly props: Readonly<Record<string, string>>;
  /** Indices into the brush list, for brush entities such as triggers. */
  readonly brushes?: readonly number[];
}

/** Brush records, one entry per brush in every array. */
export interface CmapBrushes {
  /** Brushes cover the plane list in order: brush i starts where brush i − 1 ends. */
  readonly firstPlane: Uint32Array;
  readonly planeCount: Uint32Array;
  readonly faceCount: Uint32Array;
  /** CONTENTS_* bits. */
  readonly contents: Uint32Array;
  /** 6 per brush: min xyz, max xyz, exactly the distances of the brush's axial planes. */
  readonly bounds: Float32Array;
}

/** Render surfaces, one entry per surface in every array. */
export interface CmapSurfaces {
  readonly material: Uint32Array;
  readonly firstVertex: Uint32Array;
  readonly vertexCount: Uint32Array;
  readonly firstIndex: Uint32Array;
  /** A multiple of 3: triangles. */
  readonly indexCount: Uint32Array;
}

/** What the encoder writes: everything except the content hash, which it computes. */
export interface CmapData {
  readonly name: string;
  readonly bounds: CmapBounds;
  readonly compiler: CmapCompiler;
  readonly entities: readonly CmapEntity[];
  readonly materials: readonly string[];
  readonly units: "inch";
  readonly up: "z";
  /** 4 per plane: nx, ny, nz, d. */
  readonly planes: Float32Array;
  /** SURF_* bits per plane (0 for bevels). */
  readonly planeSurfaceFlags: Uint32Array;
  /** Index into `materials` per plane; −1 exactly for bevels. */
  readonly planeMaterial: Int32Array;
  readonly brushes: CmapBrushes;
  readonly surfaces: CmapSurfaces;
  /** CMAP_VERTEX_FLOATS per vertex. */
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}

export interface Cmap extends CmapData {
  /** 16 lowercase hex digits (cmapHash.ts), as stored in the preamble. */
  readonly contentHash: string;
}

export interface DecodeCmapOptions {
  /** Recompute the content hash and reject a mismatch. Default true. */
  readonly verifyHash?: boolean;
}

/** A file decodeCmap refuses, or a Cmap buildCollisionWorld refuses: a broken or foreign file. */
export class CmapError extends Error {
  override name = "CmapError";
}

function fail(message: string): never {
  throw new CmapError(message);
}

function tagName(tag: number): string {
  let text = "";
  for (let i = 0; i < 4; i++) {
    const c = (tag >>> (8 * i)) & 0xff;
    if (c < 0x20 || c > 0x7e) return `0x${tag.toString(16).padStart(8, "0")}`;
    text += String.fromCharCode(c);
  }
  return text;
}

/** Most bytes handed to one String.fromCharCode call, well below engines' argument limits. */
const JSON_CHUNK = 4096;

function asciiText(bytes: Uint8Array, start: number, end: number): string {
  for (let i = start; i < end; i++) {
    if ((bytes[i] as number) >= 0x80) fail(`JSON byte ${i - start} is not ASCII`);
  }
  let text = "";
  for (let i = start; i < end; i += JSON_CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + JSON_CHUNK)));
  }
  return text;
}

function isJsonSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/**
 * The JSON text without its padding. It must neither start nor end with whitespace and be padded
 * with fewer than CMAP_ALIGN spaces, so the text and the padding are unambiguous.
 */
function jsonText(bytes: Uint8Array, start: number, end: number): string {
  let textEnd = end;
  while (textEnd > start && bytes[textEnd - 1] === 0x20) textEnd--;
  if (end - textEnd >= CMAP_ALIGN) fail(`JSON padding is ${end - textEnd} spaces, not under 8`);
  if (textEnd > start && isJsonSpace(bytes[start] as number)) fail("JSON starts with whitespace");
  if (textEnd > start && isJsonSpace(bytes[textEnd - 1] as number)) {
    fail("JSON ends with whitespace other than the space padding");
  }
  return asciiText(bytes, start, textEnd);
}

function alignUp(n: number): number {
  return n + ((CMAP_ALIGN - (n % CMAP_ALIGN)) % CMAP_ALIGN);
}

function checkZeroPadding(bytes: Uint8Array, start: number, end: number): void {
  for (let i = start; i < end; i++) {
    if (bytes[i] !== 0) fail(`padding byte at offset ${i} is not 0`);
  }
}

// JSON structure checks: JSON.parse only promises some JSON value.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every required key is present and no other key is, so a typo can't pass unnoticed. */
function checkKeys(
  v: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  where: string,
): void {
  for (const key of required) {
    if (!Object.hasOwn(v, key)) fail(`${where}: missing key "${key}"`);
  }
  for (const key of Object.keys(v)) {
    if (!required.includes(key) && !optional.includes(key)) {
      fail(`${where}: unknown key ${JSON.stringify(key)}`);
    }
  }
}

function record(v: unknown, where: string): Record<string, unknown> {
  if (!isRecord(v)) fail(`${where} must be an object`);
  return v;
}

function array(v: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(v)) fail(`${where} must be an array`);
  return v;
}

function text(v: unknown, where: string, nonEmpty = true): string {
  if (typeof v !== "string") fail(`${where} must be a string`);
  if (nonEmpty && v.length === 0) fail(`${where} must not be empty`);
  return v;
}

function finite(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${where} must be a finite number`);
  return v + 0;
}

function vec3(v: unknown, where: string): CmapVec3 {
  const a = array(v, where);
  if (a.length !== 3) fail(`${where} must have 3 numbers, not ${a.length}`);
  return [finite(a[0], `${where}[0]`), finite(a[1], `${where}[1]`), finite(a[2], `${where}[2]`)];
}

function entity(v: unknown, where: string, brushCount: number): CmapEntity {
  const o = record(v, where);
  checkKeys(o, ["classname", "props"], ["origin", "angles", "brushes"], where);
  const props = record(o.props, `${where}.props`);
  for (const key of Object.keys(props)) {
    text(props[key], `${where}.props[${JSON.stringify(key)}]`, false);
  }
  const result: {
    classname: string;
    origin?: CmapVec3;
    angles?: CmapVec3;
    props: Readonly<Record<string, string>>;
    brushes?: readonly number[];
  } = {
    classname: text(o.classname, `${where}.classname`),
    props: props as Record<string, string>,
  };
  if (o.origin !== undefined) result.origin = vec3(o.origin, `${where}.origin`);
  if (o.angles !== undefined) result.angles = vec3(o.angles, `${where}.angles`);
  if (o.brushes !== undefined) {
    const list = array(o.brushes, `${where}.brushes`);
    const brushes: number[] = [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b >= brushCount) {
        fail(`${where}.brushes[${i}] must be a brush index in 0…${brushCount - 1}`);
      }
      brushes.push(b + 0);
    }
    result.brushes = brushes;
  }
  return result;
}

type CmapMeta = Pick<
  CmapData,
  "name" | "bounds" | "compiler" | "entities" | "materials" | "units" | "up"
>;

function parseMeta(json: string, brushCount: number): CmapMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    fail(`JSON does not parse: ${e instanceof Error ? e.message : String(e)}`);
  }
  const root = record(parsed, "JSON");
  checkKeys(
    root,
    ["bounds", "compiler", "entities", "materials", "name", "units", "up"],
    [],
    "JSON",
  );
  const b = record(root.bounds, "bounds");
  checkKeys(b, ["maxs", "mins"], [], "bounds");
  const mins = vec3(b.mins, "bounds.mins");
  const maxs = vec3(b.maxs, "bounds.maxs");
  for (let k = 0; k < 3; k++) {
    if (!((mins[k] as number) <= (maxs[k] as number))) fail(`bounds: mins > maxs on axis ${k}`);
  }
  const c = record(root.compiler, "compiler");
  checkKeys(c, ["name", "version"], [], "compiler");
  const version = c.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
    fail("compiler.version must be a non-negative integer");
  }
  const entityList = array(root.entities, "entities");
  const entities: CmapEntity[] = [];
  for (let i = 0; i < entityList.length; i++) {
    entities.push(entity(entityList[i], `entities[${i}]`, brushCount));
  }
  const materialList = array(root.materials, "materials");
  const materials: string[] = [];
  for (let i = 0; i < materialList.length; i++) {
    materials.push(text(materialList[i], `materials[${i}]`));
  }
  if (root.units !== "inch") fail(`units must be "inch"`);
  if (root.up !== "z") fail(`up must be "z"`);
  return {
    name: text(root.name, "name"),
    bounds: { mins, maxs },
    compiler: { name: text(c.name, "compiler.name"), version: version + 0 },
    entities,
    materials,
    units: "inch",
    up: "z",
  };
}

interface SectionEntry {
  offset: number;
  count: number;
}

function readF32(view: DataView, entry: SectionEntry, perRecord: number, what: string) {
  const out = new Float32Array(entry.count * perRecord);
  for (let i = 0; i < out.length; i++) {
    const v = view.getFloat32(entry.offset + 4 * i, true);
    if (!Number.isFinite(v))
      fail(`${what} value ${i} (record ${(i / perRecord) | 0}) is not finite`);
    out[i] = v;
  }
  return out;
}

/** Field `field` of every `recordBytes` record, as u32. */
function readU32Field(view: DataView, entry: SectionEntry, recordBytes: number, field: number) {
  const out = new Uint32Array(entry.count);
  for (let i = 0; i < entry.count; i++) {
    out[i] = view.getUint32(entry.offset + recordBytes * i + 4 * field, true);
  }
  return out;
}

/**
 * Decodes and fully validates a cmap file. Throws CmapError with a precise message on anything
 * malformed and never returns partial data. Load time only: it allocates. With verifyHash false,
 * contentHash is the stored value, unchecked.
 */
export function decodeCmap(bytes: Uint8Array, options?: DecodeCmapOptions): Cmap {
  const length = bytes.length;
  if (length < CMAP_PREAMBLE_BYTES) {
    fail(`${length} bytes is shorter than the ${CMAP_PREAMBLE_BYTES}-byte preamble`);
  }
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== CMAP_MAGIC.charCodeAt(i)) fail(`bad magic: not a ${CMAP_MAGIC} file`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const formatVersion = view.getUint32(4, true);
  if (formatVersion !== CMAP_FORMAT_VERSION) {
    fail(`format version ${formatVersion}, this build reads ${CMAP_FORMAT_VERSION}`);
  }
  const jsonByteLength = view.getUint32(8, true);
  const sectionCount = view.getUint32(12, true);
  const hashLo = view.getUint32(CMAP_HASH_OFFSET, true);
  const hashHi = view.getUint32(CMAP_HASH_OFFSET + 4, true);
  const totalByteLength = view.getUint32(24, true);
  if (totalByteLength !== length) {
    fail(`totalByteLength says ${totalByteLength} bytes, the file has ${length}`);
  }
  if (view.getUint32(28, true) !== 0) fail("reserved preamble word is not 0");

  const tableEnd = CMAP_PREAMBLE_BYTES + CMAP_SECTION_ENTRY_BYTES * sectionCount;
  if (tableEnd > length) fail(`section table (${sectionCount} entries) runs past the end`);
  if (jsonByteLength % CMAP_ALIGN !== 0) {
    fail(`jsonByteLength ${jsonByteLength} is not a multiple of ${CMAP_ALIGN}`);
  }
  const jsonEnd = tableEnd + jsonByteLength;
  if (jsonEnd > length) fail(`JSON (${jsonByteLength} bytes) runs past the end`);

  const found = new Map<number, SectionEntry>();
  let previousEnd = jsonEnd;
  for (let s = 0; s < sectionCount; s++) {
    const at = CMAP_PREAMBLE_BYTES + CMAP_SECTION_ENTRY_BYTES * s;
    const tag = view.getUint32(at, true);
    const offset = view.getUint32(at + 4, true);
    const byteLength = view.getUint32(at + 8, true);
    const count = view.getUint32(at + 12, true);
    const where = `section ${s} (${tagName(tag)})`;
    if (offset % CMAP_ALIGN !== 0) fail(`${where}: offset ${offset} is not ${CMAP_ALIGN}-aligned`);
    if (offset + byteLength > length) fail(`${where}: runs past the end of the file`);
    if (offset < jsonEnd) fail(`${where}: overlaps the preamble, section table or JSON`);
    if (offset < previousEnd) {
      fail(`${where}: starts before the end of the previous section (sections follow table order)`);
    }
    // Exactly the encoder's layout, so every byte of an accepted file is meaningful.
    if (offset > alignUp(previousEnd)) fail(`${where}: leaves a gap after the previous data`);
    checkZeroPadding(bytes, previousEnd, offset);
    previousEnd = offset + byteLength;
    let recordBytes = 0;
    for (let k = 0; k < CMAP_SECTIONS.length; k++) {
      const known = CMAP_SECTIONS[k] as readonly [number, number];
      if (known[0] === tag) recordBytes = known[1];
    }
    // Unknown tags are skipped, so later versions can add sections old readers ignore.
    if (recordBytes === 0) continue;
    if (byteLength !== count * recordBytes) {
      fail(`${where}: ${byteLength} bytes for ${count} records of ${recordBytes} bytes`);
    }
    if (found.has(tag)) fail(`${where}: appears twice`);
    found.set(tag, { offset, count });
  }
  if (alignUp(previousEnd) !== length) {
    fail(`${length - alignUp(previousEnd)} bytes after the last section's padding`);
  }
  checkZeroPadding(bytes, previousEnd, length);
  const section = (tag: number): SectionEntry => {
    const entry = found.get(tag);
    if (entry === undefined) fail(`required section ${tagName(tag)} is missing`);
    return entry;
  };
  const plns = section(CMAP_TAG_PLANES);
  const plsf = section(CMAP_TAG_PLANE_SURFACES);
  const brsh = section(CMAP_TAG_BRUSHES);
  const surf = section(CMAP_TAG_SURFACES);
  const vtxs = section(CMAP_TAG_VERTICES);
  const idxs = section(CMAP_TAG_INDICES);

  const meta = parseMeta(jsonText(bytes, tableEnd, jsonEnd), brsh.count);

  const planeTotal = plns.count;
  if (plsf.count !== planeTotal) fail(`PLSF has ${plsf.count} records for ${planeTotal} planes`);
  const planes = readF32(view, plns, 4, "PLNS");
  const planeSurfaceFlags = readU32Field(view, plsf, 8, 0);
  const planeMaterial = new Int32Array(planeTotal);
  for (let p = 0; p < planeTotal; p++)
    planeMaterial[p] = view.getInt32(plsf.offset + 8 * p + 4, true);

  const brushes: CmapBrushes = {
    firstPlane: readU32Field(view, brsh, 40, 0),
    planeCount: readU32Field(view, brsh, 40, 1),
    faceCount: readU32Field(view, brsh, 40, 2),
    contents: readU32Field(view, brsh, 40, 3),
    bounds: new Float32Array(6 * brsh.count),
  };
  for (let i = 0; i < brsh.count; i++) {
    for (let k = 0; k < 6; k++) {
      const v = view.getFloat32(brsh.offset + 40 * i + 16 + 4 * k, true);
      if (!Number.isFinite(v)) fail(`brush ${i}: bounds value ${k} is not finite`);
      brushes.bounds[6 * i + k] = v;
    }
  }
  validateBrushes(meta.materials.length, planes, planeSurfaceFlags, planeMaterial, brushes);

  const vertices = readF32(view, vtxs, CMAP_VERTEX_FLOATS, "VTXS");
  const indices = readU32Field(view, idxs, 4, 0);
  const surfaces: CmapSurfaces = {
    material: readU32Field(view, surf, 24, 0),
    firstVertex: readU32Field(view, surf, 24, 1),
    vertexCount: readU32Field(view, surf, 24, 2),
    firstIndex: readU32Field(view, surf, 24, 3),
    indexCount: readU32Field(view, surf, 24, 4),
  };
  for (let i = 0; i < surf.count; i++) {
    if (view.getUint32(surf.offset + 24 * i + 20, true) !== 0) {
      fail(`surface ${i}: reserved word is not 0`);
    }
  }
  validateSurfaces(meta.materials.length, vtxs.count, indices, surfaces);

  let contentHash = cmapHashHex({ lo: hashLo, hi: hashHi });
  if (options?.verifyHash ?? true) {
    const actual = cmapHashHex(cmapContentHash(bytes));
    if (actual !== contentHash) {
      fail(`contentHash mismatch: the preamble says ${contentHash}, the bytes hash to ${actual}`);
    }
    contentHash = actual;
  }
  return {
    name: meta.name,
    bounds: meta.bounds,
    compiler: meta.compiler,
    entities: meta.entities,
    materials: meta.materials,
    units: meta.units,
    up: meta.up,
    planes,
    planeSurfaceFlags,
    planeMaterial,
    brushes,
    surfaces,
    vertices,
    indices,
    contentHash,
  };
}

/** One brush as createCollisionWorld takes it: views into the cmap arrays, no copies. */
function brushSource(
  planes: Float32Array,
  planeSurfaceFlags: Uint32Array,
  brushes: CmapBrushes,
  i: number,
): CollisionBrushSource {
  const first = brushes.firstPlane[i] as number;
  const end = first + (brushes.planeCount[i] as number);
  return {
    planes: planes.subarray(4 * first, 4 * end),
    faceCount: brushes.faceCount[i] as number,
    bounds: brushes.bounds.subarray(6 * i, 6 * i + 6),
    contents: brushes.contents[i] as number,
    surfaceFlags: planeSurfaceFlags.subarray(first, end),
  };
}

function validateBrushes(
  materialCount: number,
  planes: Float32Array,
  planeSurfaceFlags: Uint32Array,
  planeMaterial: Int32Array,
  brushes: CmapBrushes,
): void {
  const brushCount = brushes.firstPlane.length;
  const planeTotal = planeMaterial.length;
  let next = 0;
  for (let i = 0; i < brushCount; i++) {
    const first = brushes.firstPlane[i] as number;
    const count = brushes.planeCount[i] as number;
    const faces = brushes.faceCount[i] as number;
    const contents = brushes.contents[i] as number;
    // Each plane belongs to exactly one brush, which decides whether it is a face or a bevel.
    if (first !== next) fail(`brush ${i}: firstPlane ${first}, expected ${next} (planes in order)`);
    if (first + count > planeTotal) fail(`brush ${i}: planes ${first}+${count} past ${planeTotal}`);
    if (count < 4) fail(`brush ${i}: planeCount ${count} is below 4`);
    if (faces > count) fail(`brush ${i}: faceCount ${faces} exceeds planeCount ${count}`);
    if (faces < 4) fail(`brush ${i}: faceCount ${faces} is below 4`);
    if (contents === 0 || (contents & ~CONTENTS_KNOWN) !== 0) {
      fail(
        `brush ${i}: contents 0x${contents.toString(16)} must be non-zero known CONTENTS_* bits`,
      );
    }
    for (let p = first; p < first + count; p++) {
      const m = planeMaterial[p] as number;
      const bevel = p - first >= faces;
      if (bevel ? m !== -1 : m < 0 || m >= materialCount) {
        fail(
          `plane ${p} (brush ${i} ${bevel ? "bevel" : "face"}): material ${m}, expected ${
            bevel ? "-1" : `0…${materialCount - 1}`
          }`,
        );
      }
    }
    next = first + count;
  }
  if (next !== planeTotal) fail(`brushes use ${next} of the ${planeTotal} planes`);
  // The remaining collision rules (f32 unit normals, bounds equal to the axial planes, known
  // surface flags) are createCollisionWorld's; run them now so a bad file fails as a CmapError.
  for (let i = 0; i < brushCount; i++) {
    try {
      validateCollisionBrush(brushSource(planes, planeSurfaceFlags, brushes, i), i);
    } catch (e) {
      if (e instanceof CollisionWorldError) fail(e.message);
      throw e;
    }
  }
}

function validateSurfaces(
  materialCount: number,
  vertexTotal: number,
  indices: Uint32Array,
  surfaces: CmapSurfaces,
): void {
  // Covers indices no surface references; the per-surface bound below is the tighter one.
  for (let k = 0; k < indices.length; k++) {
    const index = indices[k] as number;
    if (index >= vertexTotal) fail(`index ${k} is ${index}, past the ${vertexTotal} vertices`);
  }
  for (let i = 0; i < surfaces.material.length; i++) {
    const material = surfaces.material[i] as number;
    const firstVertex = surfaces.firstVertex[i] as number;
    const vertexCount = surfaces.vertexCount[i] as number;
    const firstIndex = surfaces.firstIndex[i] as number;
    const indexCount = surfaces.indexCount[i] as number;
    if (material >= materialCount) fail(`surface ${i}: material ${material} out of range`);
    if (firstVertex + vertexCount > vertexTotal) {
      fail(`surface ${i}: vertices ${firstVertex}+${vertexCount} past ${vertexTotal}`);
    }
    if (firstIndex + indexCount > indices.length) {
      fail(`surface ${i}: indices ${firstIndex}+${indexCount} past ${indices.length}`);
    }
    if (indexCount % 3 !== 0) fail(`surface ${i}: indexCount ${indexCount} is not triangles`);
    for (let k = firstIndex; k < firstIndex + indexCount; k++) {
      const index = indices[k] as number;
      if (index >= vertexCount) {
        fail(`surface ${i}: index ${k} is ${index}, past its ${vertexCount} vertices`);
      }
    }
  }
}

/**
 * The collision world of a cmap: planes widened from f32 to f64 (exact) and the BVH built, both
 * deterministically. Throws CmapError when the brushes break createCollisionWorld's rules, which
 * a Cmap from decodeCmap never does.
 */
export function buildCollisionWorld(cmap: CmapData): CollisionWorld {
  const b = cmap.brushes;
  const planeTotal = cmap.planes.length / 4;
  const sources: CollisionBrushSource[] = [];
  for (let i = 0; i < b.firstPlane.length; i++) {
    const end = (b.firstPlane[i] as number) + (b.planeCount[i] as number);
    if (end > planeTotal || end > cmap.planeSurfaceFlags.length || 6 * i + 6 > b.bounds.length) {
      fail(`brush ${i}: record points past the plane or bounds arrays`);
    }
    sources.push(brushSource(cmap.planes, cmap.planeSurfaceFlags, b, i));
  }
  try {
    return createCollisionWorld(sources);
  } catch (e) {
    if (e instanceof CollisionWorldError) fail(e.message);
    throw e;
  }
}
