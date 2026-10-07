import {
  CanvasTexture,
  Color,
  DoubleSide,
  type Material,
  MeshLambertMaterial,
  RepeatWrapping,
  SRGBColorSpace,
} from "three";

/**
 * Greybox materials (M2 design §2 "World"): Lambert-lit procedural grid textures, so distance,
 * speed and slopes read before there is any art (docs/08 look-dev comes later). The cmap's uv0 is
 * 1 per 64 u (docs/07 §3), so one 256² tile is 64 u: minor lines every 16 u, a major line on the
 * tile edge, repeat-wrapped so the grid lines up across brushes.
 */

export const GRID_TEXTURE_SIZE = 256;
/** Pixels per 16 u minor cell (256 px per 64 u tile). */
const MINOR_PX = GRID_TEXTURE_SIZE / 4;

export const MATERIAL_FLOOR = 0;
export const MATERIAL_WALL = 1;
export const MATERIAL_LADDER = 2;
export const MATERIAL_WATER = 3;
export const MATERIAL_UNKNOWN = 4;

/** Which greybox look a cmap material name gets; anything unrecognised is loud magenta. */
export function materialKind(name: string): number {
  if (name === "grey/floor" || name.startsWith("grey/floor_")) return MATERIAL_FLOOR;
  if (name === "grey/wall" || name.startsWith("grey/wall_")) return MATERIAL_WALL;
  if (name === "grey/ladder") return MATERIAL_LADDER;
  if (name === "grey/water") return MATERIAL_WATER;
  return MATERIAL_UNKNOWN;
}

/** Base, minor-line and major-line colours per kind (sRGB hex). */
const PALETTE: Record<number, readonly [string, string, string]> = {
  [MATERIAL_FLOOR]: ["#b4b4b0", "#a2a29e", "#7c7c78"],
  [MATERIAL_WALL]: ["#8c8c8c", "#7e7e7e", "#5e5e5e"],
  [MATERIAL_LADDER]: ["#8c8c8c", "#7e7e7e", "#4a3c2c"],
  [MATERIAL_WATER]: ["#3a78c8", "#346cb4", "#2a5890"],
};
/** The alternate floor is a shade darker, so neighbouring floor brushes tell apart. */
const FLOOR_ALT_PALETTE = ["#a8a8a4", "#989894", "#747470"] as const;

/** The 2D context calls the painter uses (a real canvas's, or a recording fake in tests). */
export interface GridContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
}

/** A canvas the texture can be painted on and uploaded from. */
export interface GridCanvas {
  width: number;
  height: number;
  getContext(id: "2d"): GridContext | null;
}

/**
 * Paints a grid tile: base fill, 1 px minor lines every 16 u, a 3 px major line on the 64 u edge
 * (it wraps, so half of it shows on each side). A ladder face adds rungs: v runs up a ladder's
 * vertical face (docs/07 §3), so they are rows, 4 px thick every 16 u.
 */
export function paintGrid(
  ctx: GridContext,
  colors: readonly [string, string, string],
  rungs: boolean,
): void {
  const s = GRID_TEXTURE_SIZE;
  ctx.fillStyle = colors[0];
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = colors[1];
  for (let p = MINOR_PX; p < s; p += MINOR_PX) {
    ctx.fillRect(p, 0, 1, s);
    ctx.fillRect(0, p, s, 1);
  }
  ctx.fillStyle = colors[2];
  ctx.fillRect(0, 0, 2, s);
  ctx.fillRect(s - 1, 0, 1, s);
  ctx.fillRect(0, 0, s, 2);
  ctx.fillRect(0, s - 1, s, 1);
  if (rungs) {
    for (let p = MINOR_PX / 2; p < s; p += MINOR_PX) ctx.fillRect(0, p - 2, s, 4);
  }
}

/**
 * Builds and owns the world's materials, one per cmap material name, and their textures;
 * `dispose()` frees them all (on map unload). `createCanvas` makes the canvases: a DOM canvas in
 * the page, a fake one in Node tests.
 */
export class GreyboxMaterials {
  private readonly byName = new Map<string, Material>();
  private readonly textures: CanvasTexture[] = [];

  constructor(private readonly createCanvas: () => GridCanvas) {}

  get(name: string): Material {
    let m = this.byName.get(name);
    if (m === undefined) {
      m = this.create(name);
      this.byName.set(name, m);
    }
    return m;
  }

  get size(): number {
    return this.byName.size;
  }

  dispose(): void {
    for (const m of this.byName.values()) m.dispose();
    for (const t of this.textures) t.dispose();
    this.byName.clear();
    this.textures.length = 0;
  }

  private create(name: string): Material {
    const kind = materialKind(name);
    if (kind === MATERIAL_UNKNOWN) {
      return new MeshLambertMaterial({ color: new Color(0xff00ff), name });
    }
    const colors = name === "grey/floor_alt" ? FLOOR_ALT_PALETTE : (PALETTE[kind] ?? PALETTE[0]);
    const map = this.texture(colors as readonly [string, string, string], kind === MATERIAL_LADDER);
    if (kind === MATERIAL_WATER) {
      return new MeshLambertMaterial({
        map,
        name,
        transparent: true,
        opacity: 0.5,
        side: DoubleSide,
        depthWrite: false,
      });
    }
    return new MeshLambertMaterial({ map, name });
  }

  private texture(colors: readonly [string, string, string], rungs: boolean): CanvasTexture {
    const canvas = this.createCanvas();
    canvas.width = GRID_TEXTURE_SIZE;
    canvas.height = GRID_TEXTURE_SIZE;
    const ctx = canvas.getContext("2d");
    if (ctx !== null) paintGrid(ctx, colors, rungs);
    const t = new CanvasTexture(canvas as unknown as HTMLCanvasElement);
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    this.textures.push(t);
    return t;
  }
}
