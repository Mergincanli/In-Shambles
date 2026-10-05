import { describe, expect, it } from "vitest";
import { buildBrush } from "../../src/world/brushBuild";
import {
  buildCollisionWorld,
  CMAP_TAG_BRUSHES,
  CMAP_TAG_INDICES,
  CMAP_TAG_PLANE_SURFACES,
  CMAP_TAG_PLANES,
  CMAP_TAG_SURFACES,
  CMAP_TAG_VERTICES,
  type CmapData,
  CmapError,
  cmapTag,
  decodeCmap,
} from "../../src/world/cmap";
import { CMAP_HASH_OFFSET, cmapContentHash, cmapHashHex } from "../../src/world/cmapHash";
import { createCollisionWorld } from "../../src/world/collisionWorld";
import { CONTENTS_LADDER, CONTENTS_SOLID, SURF_LADDER, SURF_SLICK } from "../../src/world/contents";
import { boxPlanes, rotatedBoxPlanes } from "../../src/world/shapes";

// shared can't import the tools encoder, so these files are written byte by byte. The full
// encode/decode suite, with every rejection path, is packages/tools/test/greybox/cmap.test.ts.

const JSON_TEXT =
  '{"bounds":{"maxs":[0,0,0],"mins":[0,0,0]},"compiler":{"name":"hand","version":0},' +
  '"entities":[{"classname":"info_player_start","origin":[0,0,24],"props":{}}],' +
  '"materials":[],"name":"empty","units":"inch","up":"z"}';

interface HandSection {
  tag: number;
  recordBytes: number;
  count: number;
  /** Writes record `i` at byte offset `at`. */
  write?: (view: DataView, at: number, i: number) => void;
}

const align8 = (n: number) => Math.ceil(n / 8) * 8;

/** A file laid out as docs/07 §2 describes it, each field written at its documented offset. */
function handMap(json: string, sections: readonly HandSection[]): Uint8Array {
  const jsonStart = 32 + 16 * sections.length;
  const jsonLength = align8(json.length);
  const offsets: number[] = [];
  let total = jsonStart + jsonLength;
  for (const s of sections) {
    offsets.push(total);
    total = align8(total + s.count * s.recordBytes);
  }
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, cmapTag("CMAP"), true);
  view.setUint32(4, 1, true);
  view.setUint32(8, jsonLength, true);
  view.setUint32(12, sections.length, true);
  view.setUint32(24, total, true);
  sections.forEach((s, k) => {
    const offset = offsets[k] as number;
    view.setUint32(32 + 16 * k, s.tag, true);
    view.setUint32(32 + 16 * k + 4, offset, true);
    view.setUint32(32 + 16 * k + 8, s.count * s.recordBytes, true);
    view.setUint32(32 + 16 * k + 12, s.count, true);
    for (let i = 0; i < s.count; i++) s.write?.(view, offset + s.recordBytes * i, i);
  });
  for (let i = 0; i < jsonLength; i++)
    bytes[jsonStart + i] = i < json.length ? json.charCodeAt(i) : 0x20;
  const hash = cmapContentHash(bytes);
  view.setUint32(CMAP_HASH_OFFSET, hash.lo, true);
  view.setUint32(CMAP_HASH_OFFSET + 4, hash.hi, true);
  return bytes;
}

const SECTION_SIZES: readonly (readonly [number, number])[] = [
  [CMAP_TAG_PLANES, 16],
  [CMAP_TAG_PLANE_SURFACES, 8],
  [CMAP_TAG_BRUSHES, 40],
  [CMAP_TAG_SURFACES, 24],
  [CMAP_TAG_VERTICES, 32],
  [CMAP_TAG_INDICES, 4],
];

/** A file with no geometry: preamble, six empty sections, the JSON. */
function emptyMap(json = JSON_TEXT): Uint8Array {
  return handMap(
    json,
    SECTION_SIZES.map(([tag, recordBytes]) => ({ tag, recordBytes, count: 0 })),
  );
}

describe("decodeCmap on a hand-written file", () => {
  it("reads the metadata and empty sections", () => {
    const bytes = emptyMap();
    const cmap = decodeCmap(bytes);
    expect(cmap.name).toBe("empty");
    expect(cmap.compiler).toEqual({ name: "hand", version: 0 });
    expect(cmap.entities).toEqual([
      { classname: "info_player_start", origin: [0, 0, 24], props: {} },
    ]);
    expect(cmap.planes).toEqual(new Float32Array(0));
    expect(cmap.brushes.firstPlane.length).toBe(0);
    expect(cmap.contentHash).toBe(cmapHashHex(cmapContentHash(bytes)));
    expect(buildCollisionWorld(cmap).brushCount).toBe(0);
  });

  it("normalizes -0 in JSON numbers", () => {
    const cmap = decodeCmap(emptyMap(JSON_TEXT.replace("[0,0,24]", "[-0,0,24]")));
    expect(Object.is(cmap.entities[0]?.origin?.[0], 0)).toBe(true);
  });

  it("refuses a bad magic, another version and a stale hash with CmapError", () => {
    const magic = emptyMap();
    magic[3] = 0x51;
    expect(() => decodeCmap(magic)).toThrow(/bad magic/);
    const version = emptyMap();
    version[4] = 2;
    expect(() => decodeCmap(version)).toThrow(/format version 2/);
    const stale = emptyMap();
    stale[32 + 16 * 6 + JSON_TEXT.indexOf('"empty"') + 5] = "Y".charCodeAt(0);
    expect(() => decodeCmap(stale)).toThrow(CmapError);
    expect(() => decodeCmap(stale)).toThrow(/contentHash mismatch/);
    expect(decodeCmap(stale, { verifyHash: false }).name).toBe("emptY");
  });
});

describe("decodeCmap reads every record field at its documented offset", () => {
  // One rotated box (faces, then axial bevels), one surface, four vertices: field values are
  // chosen pairwise distinct so a swap of two fields on both encoder and decoder shows up here.
  const brush = buildBrush(rotatedBoxPlanes([10, 20, 30], [16, 8, 4], Math.sqrt(3) / 2, 0.5));
  const planeCount = brush.planes.length / 4;
  const flags = (p: number) => (p === 1 ? SURF_LADDER : p === 2 ? SURF_SLICK : 0);
  const material = (p: number) => (p < brush.faceCount ? p % 2 : -1);
  const vertex = (i: number, k: number) => 100 * i + k + 0.5;
  const indices = [0, 0, 0, 2, 0, 1];
  const json =
    '{"bounds":{"maxs":[1,2,3],"mins":[-1,-2,-3]},"compiler":{"name":"hand","version":7},' +
    '"entities":[],"materials":["m0","m1"],"name":"fields","units":"inch","up":"z"}';
  const bytes = handMap(json, [
    {
      tag: CMAP_TAG_PLANES,
      recordBytes: 16,
      count: planeCount,
      write: (v, at, i) => {
        for (let k = 0; k < 4; k++)
          v.setFloat32(at + 4 * k, brush.planes[4 * i + k] as number, true);
      },
    },
    {
      tag: CMAP_TAG_PLANE_SURFACES,
      recordBytes: 8,
      count: planeCount,
      write: (v, at, i) => {
        v.setUint32(at, flags(i), true);
        v.setInt32(at + 4, material(i), true);
      },
    },
    {
      tag: CMAP_TAG_BRUSHES,
      recordBytes: 40,
      count: 1,
      write: (v, at) => {
        v.setUint32(at, 0, true);
        v.setUint32(at + 4, planeCount, true);
        v.setUint32(at + 8, brush.faceCount, true);
        v.setUint32(at + 12, CONTENTS_SOLID | CONTENTS_LADDER, true);
        for (let k = 0; k < 6; k++) v.setFloat32(at + 16 + 4 * k, brush.bounds[k] as number, true);
      },
    },
    {
      tag: CMAP_TAG_SURFACES,
      recordBytes: 24,
      count: 1,
      write: (v, at) => {
        v.setUint32(at, 1, true); // material
        v.setUint32(at + 4, 1, true); // firstVertex
        v.setUint32(at + 8, 3, true); // vertexCount
        v.setUint32(at + 12, 3, true); // firstIndex
        v.setUint32(at + 16, 3, true); // indexCount; +20 reserved stays 0
      },
    },
    {
      tag: CMAP_TAG_VERTICES,
      recordBytes: 32,
      count: 4,
      write: (v, at, i) => {
        for (let k = 0; k < 8; k++) v.setFloat32(at + 4 * k, vertex(i, k), true);
      },
    },
    {
      tag: CMAP_TAG_INDICES,
      recordBytes: 4,
      count: indices.length,
      write: (v, at, i) => v.setUint32(at, indices[i] as number, true),
    },
  ]);

  it("decodes the hand-written file field by field", () => {
    expect(planeCount).toBeGreaterThan(brush.faceCount);
    const cmap = decodeCmap(bytes);
    expect(cmap.compiler).toEqual({ name: "hand", version: 7 });
    expect(cmap.bounds).toEqual({ mins: [-1, -2, -3], maxs: [1, 2, 3] });
    expect(Array.from(cmap.planes)).toEqual(Array.from(brush.planes));
    expect(Array.from(cmap.planeSurfaceFlags)).toEqual(
      Array.from({ length: planeCount }, (_, p) => flags(p)),
    );
    expect(Array.from(cmap.planeMaterial)).toEqual(
      Array.from({ length: planeCount }, (_, p) => material(p)),
    );
    expect(Array.from(cmap.brushes.firstPlane)).toEqual([0]);
    expect(Array.from(cmap.brushes.planeCount)).toEqual([planeCount]);
    expect(Array.from(cmap.brushes.faceCount)).toEqual([brush.faceCount]);
    expect(Array.from(cmap.brushes.contents)).toEqual([CONTENTS_SOLID | CONTENTS_LADDER]);
    expect(Array.from(cmap.brushes.bounds)).toEqual(Array.from(brush.bounds));
    expect(Array.from(cmap.surfaces.material)).toEqual([1]);
    expect(Array.from(cmap.surfaces.firstVertex)).toEqual([1]);
    expect(Array.from(cmap.surfaces.vertexCount)).toEqual([3]);
    expect(Array.from(cmap.surfaces.firstIndex)).toEqual([3]);
    expect(Array.from(cmap.surfaces.indexCount)).toEqual([3]);
    expect(Array.from(cmap.vertices)).toEqual(
      Array.from({ length: 32 }, (_, n) => vertex(n >> 3, n & 7)),
    );
    expect(Array.from(cmap.indices)).toEqual(indices);
    expect(buildCollisionWorld(cmap).brushCount).toBe(1);
  });

  it("does not modify a buffer whose slice() returns a view, as Node's Buffer does", () => {
    class ViewSlicing extends Uint8Array {
      override slice(start?: number, end?: number): Uint8Array<ArrayBuffer> {
        return this.subarray(start, end);
      }
    }
    const file = new ViewSlicing(bytes.length);
    file.set(bytes);
    expect(decodeCmap(file).contentHash).toBe(decodeCmap(bytes).contentHash);
    expect(decodeCmap(file).contentHash).toBe(decodeCmap(bytes).contentHash);
    expect(Uint8Array.from(file)).toEqual(bytes);
  });
});

describe("buildCollisionWorld", () => {
  const box = buildBrush(boxPlanes([-64, -64, -16], [64, 64, 0]));
  const lane = buildBrush(rotatedBoxPlanes([100, 40, 112], [256, 8, 128], Math.sqrt(3) / 2, 0.5));

  function cmapOf(boundsShift = 0): CmapData {
    const planes = Float32Array.from([...box.planes, ...lane.planes]);
    const boxCount = box.planes.length / 4;
    const laneCount = lane.planes.length / 4;
    const bounds = Float32Array.from([...box.bounds, ...lane.bounds]);
    bounds[3] = (bounds[3] as number) + boundsShift;
    return {
      name: "t",
      bounds: { mins: [0, 0, 0], maxs: [0, 0, 0] },
      compiler: { name: "t", version: 0 },
      entities: [],
      materials: ["m"],
      units: "inch",
      up: "z",
      planes,
      planeSurfaceFlags: new Uint32Array(boxCount + laneCount),
      planeMaterial: new Int32Array(boxCount + laneCount),
      brushes: {
        firstPlane: Uint32Array.of(0, boxCount),
        planeCount: Uint32Array.of(boxCount, laneCount),
        faceCount: Uint32Array.of(box.faceCount, lane.faceCount),
        contents: Uint32Array.of(CONTENTS_SOLID, CONTENTS_SOLID),
        bounds,
      },
      surfaces: {
        material: new Uint32Array(0),
        firstVertex: new Uint32Array(0),
        vertexCount: new Uint32Array(0),
        firstIndex: new Uint32Array(0),
        indexCount: new Uint32Array(0),
      },
      vertices: new Float32Array(0),
      indices: new Uint32Array(0),
    };
  }

  it("widens the f32 planes exactly and matches createCollisionWorld", () => {
    const world = buildCollisionWorld(cmapOf());
    const direct = createCollisionWorld([
      { ...box, contents: CONTENTS_SOLID },
      { ...lane, contents: CONTENTS_SOLID },
    ]);
    expect(world).toEqual(direct);
    expect(Array.from(world.planes)).toEqual([...box.planes, ...lane.planes]);
  });

  it("turns createCollisionWorld's refusals into CmapError", () => {
    expect(() => buildCollisionWorld(cmapOf(1))).toThrow(CmapError);
    expect(() => buildCollisionWorld(cmapOf(1))).toThrow(/not the distance of a \+x plane/);
  });
});
