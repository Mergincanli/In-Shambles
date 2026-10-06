import { CMAP_VERTEX_FLOATS, type Cmap } from "@game/shared";
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Group,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  type Material,
  Mesh,
} from "three";
import { convertVertices } from "./space";

/**
 * The map's render geometry (M2 design §2 "World"): one mesh per cmap render surface. The
 * compiler already merges each material into one surface (docs/07 §3), so this is one draw call
 * per material. Vertices are converted to scene space once, here, at load time (space.ts).
 */
export class WorldMesh {
  readonly group = new Group();
  /** Triangles across every surface. */
  triangles = 0;
  /** Scene-space bounds of all render vertices (m). */
  readonly bounds = new Box3();
  private readonly geometries: BufferGeometry[] = [];

  /** Frees the geometry (the materials belong to whoever made them). */
  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    this.group.clear();
    this.triangles = 0;
    this.bounds.makeEmpty();
  }

  /** @internal */
  addSurface(geometry: BufferGeometry, material: Material, name: string): void {
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    // Water draws after the opaque world so it blends over what is behind it.
    if (material.transparent) mesh.renderOrder = 1;
    this.geometries.push(geometry);
    this.group.add(mesh);
  }
}

/** Builds the world meshes of `cmap`, taking each surface's material from `materialFor`. */
export function buildWorldMesh(cmap: Cmap, materialFor: (name: string) => Material): WorldMesh {
  const world = new WorldMesh();
  const s = cmap.surfaces;
  for (let i = 0; i < s.material.length; i++) {
    const vertexCount = s.vertexCount[i] as number;
    const indexCount = s.indexCount[i] as number;
    if (vertexCount === 0 || indexCount === 0) continue;
    const name = cmap.materials[s.material[i] as number] ?? "";
    const verts = convertVertices(cmap.vertices, s.firstVertex[i] as number, vertexCount);
    const buffer = new InterleavedBuffer(verts, CMAP_VERTEX_FLOATS);
    const g = new BufferGeometry();
    g.setAttribute("position", new InterleavedBufferAttribute(buffer, 3, 0));
    g.setAttribute("normal", new InterleavedBufferAttribute(buffer, 3, 3));
    g.setAttribute("uv", new InterleavedBufferAttribute(buffer, 2, 6));
    const first = s.firstIndex[i] as number;
    // Indices are relative to the surface's first vertex (docs/07 §2), as this buffer is.
    const indices = cmap.indices.slice(first, first + indexCount);
    g.setIndex(
      vertexCount <= 0xffff
        ? new BufferAttribute(Uint16Array.from(indices), 1)
        : new BufferAttribute(indices, 1),
    );
    g.computeBoundingBox();
    g.computeBoundingSphere();
    if (g.boundingBox !== null) world.bounds.union(g.boundingBox);
    world.triangles += indexCount / 3;
    world.addSurface(g, materialFor(name), name);
  }
  return world;
}
