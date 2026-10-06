import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CMAP_VERTEX_FLOATS, type Cmap, decodeCmap } from "@game/shared";
import {
  type Material,
  Mesh,
  MeshBasicMaterial,
  type MeshLambertMaterial,
  RepeatWrapping,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";
import {
  GRID_TEXTURE_SIZE,
  GreyboxMaterials,
  type GridCanvas,
  type GridContext,
  MATERIAL_FLOOR,
  MATERIAL_LADDER,
  MATERIAL_UNKNOWN,
  MATERIAL_WALL,
  MATERIAL_WATER,
  materialKind,
  paintGrid,
} from "../../src/render/materials";
import { toThree } from "../../src/render/space";
import { buildWorldMesh } from "../../src/render/world";

const mapUrl = new URL("../../../../content/maps/movement_lab.cmap", import.meta.url);
const cmap = decodeCmap(new Uint8Array(readFileSync(fileURLToPath(mapUrl))));

/** A 2D context that records its fills. */
class FakeContext implements GridContext {
  fillStyle: string | CanvasGradient | CanvasPattern = "";
  readonly fills: [string, number, number, number, number][] = [];
  fillRect(x: number, y: number, w: number, h: number): void {
    this.fills.push([String(this.fillStyle), x, y, w, h]);
  }
}

class FakeCanvas implements GridCanvas {
  width = 0;
  height = 0;
  readonly ctx = new FakeContext();
  getContext(): GridContext {
    return this.ctx;
  }
}

describe("world mesh (M2 design §2)", () => {
  it("builds one mesh per render surface of movement_lab, with every triangle", () => {
    const names: string[] = [];
    const world = buildWorldMesh(cmap, (name) => {
      names.push(name);
      return new MeshBasicMaterial({ name });
    });
    const s = cmap.surfaces;
    expect(world.group.children.length).toBe(s.material.length);
    expect(names).toEqual(Array.from(s.material, (m) => cmap.materials[m]));
    expect(names).toEqual([
      "grey/floor",
      "grey/floor_alt",
      "grey/wall",
      "grey/ladder",
      "grey/water",
    ]);
    expect(world.triangles).toBe(cmap.indices.length / 3);
    expect(world.triangles).toBe(1236);
    let drawn = 0;
    for (const child of world.group.children) {
      expect(child).toBeInstanceOf(Mesh);
      const g = (child as Mesh).geometry;
      drawn += (g.index?.count ?? 0) / 3;
      expect(g.getAttribute("position").count).toBe(g.getAttribute("uv").count);
    }
    expect(drawn).toBe(world.triangles);
    world.dispose();
    expect(world.group.children.length).toBe(0);
  });

  it("puts the vertices where space.ts says, inside the map's bounds", () => {
    const world = buildWorldMesh(cmap, () => new MeshBasicMaterial());
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    const p = new Vector3();
    const v = cmap.vertices;
    for (let i = 0; i < v.length; i += CMAP_VERTEX_FLOATS) {
      toThree(v[i] ?? 0, v[i + 1] ?? 0, v[i + 2] ?? 0, p);
      min.min(p);
      max.max(p);
    }
    // Converted vertices are stored as f32: within 0.1 mm.
    expect(world.bounds.min.distanceTo(min)).toBeLessThan(1e-4);
    expect(world.bounds.max.distanceTo(max)).toBeLessThan(1e-4);
    // The map's brush bounds, converted: x stays, sim y becomes −z, sim z becomes y.
    const lo = toThree(
      cmap.bounds.mins[0],
      cmap.bounds.maxs[1],
      cmap.bounds.mins[2],
      new Vector3(),
    );
    const hi = toThree(
      cmap.bounds.maxs[0],
      cmap.bounds.mins[1],
      cmap.bounds.maxs[2],
      new Vector3(),
    );
    expect(world.bounds.min.x).toBeGreaterThanOrEqual(lo.x - 1e-4);
    expect(world.bounds.min.y).toBeGreaterThanOrEqual(lo.y - 1e-4);
    expect(world.bounds.min.z).toBeGreaterThanOrEqual(lo.z - 1e-4);
    expect(world.bounds.max.x).toBeLessThanOrEqual(hi.x + 1e-4);
    expect(world.bounds.max.y).toBeLessThanOrEqual(hi.y + 1e-4);
    expect(world.bounds.max.z).toBeLessThanOrEqual(hi.z + 1e-4);
    // The floor spans the whole 6144 u × 8192 u lab.
    expect(world.bounds.max.x - world.bounds.min.x).toBeCloseTo(6144 * 0.0254, 3);
    expect(world.bounds.max.z - world.bounds.min.z).toBeCloseTo(8192 * 0.0254, 3);
    world.dispose();
  });

  it("draws each surface's own triangles, facing the way their normals say", () => {
    const world = buildWorldMesh(cmap, () => new MeshBasicMaterial());
    const s = cmap.surfaces;
    const v = cmap.vertices;
    const want = new Vector3();
    const pos = [new Vector3(), new Vector3(), new Vector3()];
    const nrm = new Vector3();
    const e1 = new Vector3();
    const e2 = new Vector3();
    let checked = 0;
    for (let i = 0; i < world.group.children.length; i++) {
      const g = (world.group.children[i] as Mesh).geometry;
      const index = g.index;
      const p = g.getAttribute("position");
      const n = g.getAttribute("normal");
      expect(index).not.toBeNull();
      if (index === null) continue;
      const first = s.firstIndex[i] as number;
      const firstVertex = s.firstVertex[i] as number;
      expect(index.count).toBe(s.indexCount[i]);
      for (let k = 0; k < index.count; k++) {
        const local = index.getX(k);
        expect(local).toBeLessThan(p.count);
        // The cmap's own vertex for this corner, converted independently.
        const src = (firstVertex + (cmap.indices[first + k] as number)) * CMAP_VERTEX_FLOATS;
        toThree(v[src] ?? 0, v[src + 1] ?? 0, v[src + 2] ?? 0, want);
        (pos[k % 3] as Vector3).fromBufferAttribute(p, local);
        expect((pos[k % 3] as Vector3).distanceTo(want)).toBeLessThan(1e-4);
        if (k % 3 !== 2) continue;
        // Counter-clockwise from the front: the face normal agrees with the stored normal.
        nrm.fromBufferAttribute(n, local);
        e1.subVectors(pos[1] as Vector3, pos[0] as Vector3);
        e2.subVectors(pos[2] as Vector3, pos[0] as Vector3);
        expect(e1.cross(e2).dot(nrm)).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBe(1236);
    world.dispose();
  });
});

describe("world mesh index slices", () => {
  it("gives each surface its own index slice, relative to its first vertex", () => {
    // Two surfaces whose index patterns differ (movement_lab's quads all repeat one pattern).
    const n = CMAP_VERTEX_FLOATS;
    const vertices = new Float32Array(7 * n);
    for (let i = 0; i < 7; i++) vertices.set([i * 10, i * 3, i, 0, 0, 1, 0, 0], i * n);
    const tiny = {
      materials: ["grey/floor", "grey/wall"],
      vertices,
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 2, 0, 1]),
      surfaces: {
        material: new Uint32Array([0, 1]),
        firstVertex: new Uint32Array([0, 4]),
        vertexCount: new Uint32Array([4, 3]),
        firstIndex: new Uint32Array([0, 6]),
        indexCount: new Uint32Array([6, 3]),
      },
    } as unknown as Cmap;
    const world = buildWorldMesh(tiny, () => new MeshBasicMaterial());
    const corners = world.group.children.map((child) => {
      const g = (child as Mesh).geometry;
      const p = g.getAttribute("position");
      const out: number[] = [];
      for (let k = 0; k < (g.index?.count ?? 0); k++) out.push(p.getX(g.index?.getX(k) ?? -1));
      return out.map((x) => Math.round(x / 0.0254));
    });
    expect(corners).toEqual([
      [0, 10, 20, 0, 20, 30],
      [60, 40, 50],
    ]);
    world.dispose();
  });
});

describe("greybox materials (M2 design §2)", () => {
  it("classifies cmap material names", () => {
    expect(materialKind("grey/floor")).toBe(MATERIAL_FLOOR);
    expect(materialKind("grey/floor_alt")).toBe(MATERIAL_FLOOR);
    expect(materialKind("grey/wall")).toBe(MATERIAL_WALL);
    expect(materialKind("grey/ladder")).toBe(MATERIAL_LADDER);
    expect(materialKind("grey/water")).toBe(MATERIAL_WATER);
    expect(materialKind("tool/clip")).toBe(MATERIAL_UNKNOWN);
    expect(materialKind("")).toBe(MATERIAL_UNKNOWN);
  });

  it("paints a 64 u tile with 16 u minor lines and rungs on ladders", () => {
    const plain = new FakeContext();
    paintGrid(plain, ["a", "b", "c"], false);
    expect(plain.fills[0]).toEqual(["a", 0, 0, GRID_TEXTURE_SIZE, GRID_TEXTURE_SIZE]);
    const minorX = plain.fills.filter((f) => f[0] === "b" && f[3] === 1).map((f) => f[1]);
    expect(minorX).toEqual([64, 128, 192]);
    expect(plain.fills.some((f) => f[0] === "c")).toBe(true);
    const ladder = new FakeContext();
    paintGrid(ladder, ["a", "b", "c"], true);
    const rungs = ladder.fills.filter((f) => f[4] === 4).map((f) => f[2]);
    expect(rungs).toEqual([30, 94, 158, 222]);
  });

  it("makes one material per name: water translucent, unknown magenta; dispose frees all", () => {
    const canvases: FakeCanvas[] = [];
    const mats = new GreyboxMaterials(() => {
      const c = new FakeCanvas();
      canvases.push(c);
      return c;
    });
    const floor = mats.get("grey/floor") as MeshLambertMaterial;
    expect(mats.get("grey/floor")).toBe(floor);
    expect(floor.type).toBe("MeshLambertMaterial");
    expect(floor.map?.wrapS).toBe(RepeatWrapping);
    expect(floor.map?.wrapT).toBe(RepeatWrapping);
    expect(canvases[0]?.width).toBe(256);
    expect(canvases[0]?.ctx.fills.length).toBeGreaterThan(0);
    const water = mats.get("grey/water") as MeshLambertMaterial;
    expect([water.transparent, water.opacity, water.side, water.depthWrite]).toEqual([
      true,
      0.5,
      2,
      false,
    ]);
    const unknown = mats.get("tool/whatever") as MeshLambertMaterial;
    expect(unknown.color.getHex()).toBe(0xff00ff);
    expect(unknown.map).toBeNull();
    mats.get("grey/ladder");
    mats.get("grey/wall");
    expect(mats.size).toBe(5);
    const disposed: Material[] = [];
    for (const m of [floor, water, unknown]) m.addEventListener("dispose", () => disposed.push(m));
    const textures = ["grey/floor", "grey/water", "grey/ladder", "grey/wall"].map(
      (name) => (mats.get(name) as MeshLambertMaterial).map,
    );
    let texturesFreed = 0;
    for (const t of textures) {
      expect(t).not.toBeNull();
      t?.addEventListener("dispose", () => texturesFreed++);
    }
    mats.dispose();
    expect(disposed).toEqual([floor, water, unknown]);
    expect(texturesFreed).toBe(4);
    expect(mats.size).toBe(0);
  });
});
