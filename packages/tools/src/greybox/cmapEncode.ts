import {
  CMAP_ALIGN,
  CMAP_FORMAT_VERSION,
  CMAP_HASH_OFFSET,
  CMAP_MAGIC,
  CMAP_PREAMBLE_BYTES,
  CMAP_SECTION_ENTRY_BYTES,
  CMAP_SECTIONS,
  CMAP_TAG_BRUSHES,
  CMAP_TAG_INDICES,
  CMAP_TAG_PLANE_SURFACES,
  CMAP_TAG_PLANES,
  CMAP_TAG_SURFACES,
  CMAP_TAG_VERTICES,
  CMAP_VERTEX_FLOATS,
  type CmapData,
  CmapError,
  canonicalJson,
  cmapContentHash,
} from "@game/shared";

/**
 * Writes a cmap v1 file (layout in shared/world/cmap.ts, docs/07 §2): the exact inverse of
 * decodeCmap, and canonical, so the same CmapData always gives the same bytes. Nothing in the
 * output depends on time, paths, the machine or the locale. It checks only what it needs to lay
 * the file out (array lengths agree, JSON values are finite); the semantic rules are decodeCmap's,
 * which callers run on the result.
 */
export function encodeCmap(cmap: CmapData): Uint8Array {
  const planeCount = cmap.planes.length / 4;
  if (!Number.isInteger(planeCount)) fail(`${cmap.planes.length} plane floats is not 4·n`);
  sameLength(planeCount, cmap.planeSurfaceFlags.length, "planeSurfaceFlags");
  sameLength(planeCount, cmap.planeMaterial.length, "planeMaterial");
  const b = cmap.brushes;
  const brushCount = b.firstPlane.length;
  sameLength(brushCount, b.planeCount.length, "brushes.planeCount");
  sameLength(brushCount, b.faceCount.length, "brushes.faceCount");
  sameLength(brushCount, b.contents.length, "brushes.contents");
  sameLength(6 * brushCount, b.bounds.length, "brushes.bounds");
  const s = cmap.surfaces;
  const surfaceCount = s.material.length;
  sameLength(surfaceCount, s.firstVertex.length, "surfaces.firstVertex");
  sameLength(surfaceCount, s.vertexCount.length, "surfaces.vertexCount");
  sameLength(surfaceCount, s.firstIndex.length, "surfaces.firstIndex");
  sameLength(surfaceCount, s.indexCount.length, "surfaces.indexCount");
  const vertexCount = cmap.vertices.length / CMAP_VERTEX_FLOATS;
  if (!Number.isInteger(vertexCount)) {
    fail(`${cmap.vertices.length} vertex floats is not ${CMAP_VERTEX_FLOATS}·n`);
  }

  const json = canonicalJson({
    bounds: cmap.bounds,
    compiler: cmap.compiler,
    entities: cmap.entities,
    materials: cmap.materials,
    name: cmap.name,
    units: cmap.units,
    up: cmap.up,
  });
  const jsonByteLength = alignUp(json.length);

  const counts = new Map<number, number>([
    [CMAP_TAG_PLANES, planeCount],
    [CMAP_TAG_PLANE_SURFACES, planeCount],
    [CMAP_TAG_BRUSHES, brushCount],
    [CMAP_TAG_SURFACES, surfaceCount],
    [CMAP_TAG_VERTICES, vertexCount],
    [CMAP_TAG_INDICES, cmap.indices.length],
  ]);
  const tableEnd = CMAP_PREAMBLE_BYTES + CMAP_SECTION_ENTRY_BYTES * CMAP_SECTIONS.length;
  const offsets: number[] = [];
  let cursor = tableEnd + jsonByteLength;
  for (const [tag, recordBytes] of CMAP_SECTIONS) {
    offsets.push(cursor);
    cursor = alignUp(cursor + (counts.get(tag) ?? 0) * recordBytes);
  }
  const total = cursor;
  if (total > 0xffffffff) fail(`${total} bytes is too large for a cmap`);

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 4; i++) bytes[i] = CMAP_MAGIC.charCodeAt(i);
  view.setUint32(4, CMAP_FORMAT_VERSION, true);
  view.setUint32(8, jsonByteLength, true);
  view.setUint32(12, CMAP_SECTIONS.length, true);
  view.setUint32(24, total, true);
  CMAP_SECTIONS.forEach(([tag, recordBytes], k) => {
    const at = CMAP_PREAMBLE_BYTES + CMAP_SECTION_ENTRY_BYTES * k;
    const count = counts.get(tag) ?? 0;
    view.setUint32(at, tag, true);
    view.setUint32(at + 4, offsets[k] ?? 0, true);
    view.setUint32(at + 8, count * recordBytes, true);
    view.setUint32(at + 12, count, true);
  });
  for (let i = 0; i < jsonByteLength; i++) {
    bytes[tableEnd + i] = i < json.length ? json.charCodeAt(i) : 0x20;
  }

  const [plns = 0, plsf = 0, brsh = 0, surf = 0, vtxs = 0, idxs = 0] = offsets;
  for (let i = 0; i < 4 * planeCount; i++) view.setFloat32(plns + 4 * i, at(cmap.planes, i), true);
  for (let p = 0; p < planeCount; p++) {
    view.setUint32(plsf + 8 * p, at(cmap.planeSurfaceFlags, p), true);
    view.setInt32(plsf + 8 * p + 4, at(cmap.planeMaterial, p), true);
  }
  for (let i = 0; i < brushCount; i++) {
    const o = brsh + 40 * i;
    view.setUint32(o, at(b.firstPlane, i), true);
    view.setUint32(o + 4, at(b.planeCount, i), true);
    view.setUint32(o + 8, at(b.faceCount, i), true);
    view.setUint32(o + 12, at(b.contents, i), true);
    for (let k = 0; k < 6; k++) view.setFloat32(o + 16 + 4 * k, at(b.bounds, 6 * i + k), true);
  }
  for (let i = 0; i < surfaceCount; i++) {
    const o = surf + 24 * i;
    view.setUint32(o, at(s.material, i), true);
    view.setUint32(o + 4, at(s.firstVertex, i), true);
    view.setUint32(o + 8, at(s.vertexCount, i), true);
    view.setUint32(o + 12, at(s.firstIndex, i), true);
    view.setUint32(o + 16, at(s.indexCount, i), true);
  }
  for (let i = 0; i < cmap.vertices.length; i++) {
    view.setFloat32(vtxs + 4 * i, at(cmap.vertices, i), true);
  }
  for (let i = 0; i < cmap.indices.length; i++) {
    view.setUint32(idxs + 4 * i, at(cmap.indices, i), true);
  }

  // The hash field is still zero here, which is how the hash reads it.
  const hash = cmapContentHash(bytes);
  view.setUint32(CMAP_HASH_OFFSET, hash.lo, true);
  view.setUint32(CMAP_HASH_OFFSET + 4, hash.hi, true);
  return bytes;
}

function fail(message: string): never {
  throw new CmapError(`encodeCmap: ${message}`);
}

function sameLength(expected: number, actual: number, what: string): void {
  if (actual !== expected) fail(`${what} has ${actual} entries, expected ${expected}`);
}

function alignUp(n: number): number {
  return Math.ceil(n / CMAP_ALIGN) * CMAP_ALIGN;
}

function at(a: ArrayLike<number>, i: number): number {
  return a[i] as number;
}
