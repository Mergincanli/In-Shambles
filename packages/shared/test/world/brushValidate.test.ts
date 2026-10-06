import { describe, expect, it } from "vitest";
import { BrushError, type BrushErrorCode, validatePolygons } from "../../src/world/brushValidate";
import { polygonize, roundPlanesF32 } from "../../src/world/polygonize";
import { boxPlanes } from "../../src/world/shapes";

/**
 * validatePolygons branches that polygonize's own output never reaches: hand-broken topology
 * and geometry built from a valid box.
 */

const BOX = boxPlanes([0, 0, 0], [8, 8, 8]);
const built = polygonize(BOX);

interface Input {
  allPlanes: Float64Array;
  planes: Float64Array;
  faceSource: number[];
  verts: number[];
  polygons: Uint32Array[];
}

function input(): Input {
  return {
    allPlanes: roundPlanesF32(BOX),
    planes: built.planes.slice(),
    faceSource: [...built.faceSource],
    verts: [...built.vertices],
    polygons: built.polygons.map((p) => p.slice()),
  };
}

function expectError(i: Input, code: BrushErrorCode, text: RegExp): void {
  let caught: unknown;
  try {
    validatePolygons("bad", i.allPlanes, i.planes, i.faceSource, i.verts, i.polygons);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(BrushError);
  expect((caught as BrushError).code).toBe(code);
  expect((caught as BrushError).message).toMatch(text);
}

describe("validatePolygons", () => {
  it("accepts the box polygonize built", () => {
    const i = input();
    expect(() =>
      validatePolygons("ok", i.allPlanes, i.planes, i.faceSource, i.verts, i.polygons),
    ).not.toThrow();
  });

  it("rejects fewer than 4 faces", () => {
    const i = input();
    i.polygons.length = 3;
    expectError(i, "faces", /only 3 non-redundant faces/);
  });

  it("rejects a vertex on only 2 face planes", () => {
    const i = input();
    // Move the −x face plane 1 u out: its four vertices keep two faces each.
    i.planes[3] = (i.planes[3] ?? 0) + 1;
    expectError(i, "vertex", /lies on 2 face planes, fewer than 3/);
  });

  it("rejects a vertex outside an input plane", () => {
    const i = input();
    // A redundant plane that cuts 2e-4 u into the (8, 8, 8) corner.
    const r = 1 / Math.sqrt(3);
    i.allPlanes = Float64Array.from([...i.allPlanes, r, r, r, 24 * r - 2e-4]);
    expectError(i, "vertex", /outside plane 6/);
  });

  it("rejects an edge used twice in the same direction", () => {
    const i = input();
    i.polygons.push((i.polygons[0] as Uint32Array).slice());
    i.faceSource.push(0);
    expectError(i, "open", /used twice in the same direction/);
  });

  it("rejects an edge with only one face", () => {
    const i = input();
    i.polygons.pop();
    i.faceSource.pop();
    expectError(i, "open", /the brush is open/);
  });

  it("rejects two shells (V − E + F = 4)", () => {
    const i = input();
    const shift = built.vertices.length / 3;
    for (let k = 0; k < built.vertices.length; k += 3) {
      i.verts.push(
        (built.vertices[k] ?? 0) + 100,
        built.vertices[k + 1] ?? 0,
        built.vertices[k + 2] ?? 0,
      );
    }
    for (const p of built.polygons) i.polygons.push(p.map((v) => v + shift));
    i.faceSource.push(...built.faceSource);
    expectError(i, "open", /V − E \+ F = 16 − 24 \+ 12 = 4, not 2/);
  });

  it("rejects a face that passes through one vertex twice", () => {
    const i = input();
    const p = i.polygons[0] as Uint32Array;
    p[2] = p[0] ?? 0;
    expectError(i, "vertex", /closer than the 0\.015625 u weld distance but not joined/);
  });

  it("rejects a collapsed edge", () => {
    const i = input();
    const p = i.polygons[0] as Uint32Array;
    p[1] = p[0] ?? 0;
    expectError(i, "edge", /under the 0\.015625 u weld distance/);
  });
});
