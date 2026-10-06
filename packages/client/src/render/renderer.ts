import type { Cmap } from "@game/shared";
import { Color, DirectionalLight, HemisphereLight, Scene, WebGLRenderer } from "three";
import { FirstPersonCamera } from "./camera";
import { DebugDraw } from "./debug/debugDraw";
import { GreyboxMaterials, type GridCanvas } from "./materials";
import { toThreeDir } from "./space";
import { buildWorldMesh, type WorldMesh } from "./world";

/** Sky colour behind the greybox (sRGB). */
const SKY = 0x9db3c9;
/** Direction toward the sun in sim space: high, from the south-east, off every axis. */
const SUN_DIR = [0.45, -0.3, 1] as const;

/** Whether this browser can make a WebGL 2 context (probed on a throwaway canvas). */
export function webglAvailable(): boolean {
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return gl !== null;
  } catch {
    return false;
  }
}

/**
 * The scene and its WebGL renderer (M2 design §2 "World"): the map's greybox meshes, a hemisphere
 * plus a directional light (no shadows), and the first-person camera. It only reads what the game
 * hands it each frame; nothing here touches the simulation.
 */
export class GameRenderer {
  readonly scene = new Scene();
  readonly view = new FirstPersonCamera();
  /** The `r_debug*` lines (game.ts fills them each frame). */
  readonly debug = new DebugDraw();
  private world: WorldMesh | null = null;
  private materials: GreyboxMaterials | null = null;

  constructor(
    private readonly gl: WebGLRenderer,
    private readonly canvas: HTMLCanvasElement,
  ) {
    gl.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene.background = new Color(SKY);
    const hemi = new HemisphereLight(0xe8eef8, 0x5c5850, 1.6);
    this.scene.add(hemi);
    const sun = new DirectionalLight(0xffffff, 1.4);
    toThreeDir(SUN_DIR[0], SUN_DIR[1], SUN_DIR[2], sun.position).normalize().multiplyScalar(100);
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.scene.add(this.debug.object);
  }

  /**
   * A renderer on `canvas`, or null when WebGL is unavailable (the sim still runs). Only the
   * context creation is caught: a bug in the scene setup must surface as an error, not as a
   * missing GPU.
   */
  static create(canvas: HTMLCanvasElement): GameRenderer | null {
    if (!webglAvailable()) return null;
    let gl: WebGLRenderer;
    try {
      gl = new WebGLRenderer({ canvas, antialias: true });
    } catch {
      return null;
    }
    return new GameRenderer(gl, canvas);
  }

  /** Replaces the world with `cmap`'s render surfaces. */
  loadMap(cmap: Cmap): void {
    this.unloadMap();
    const materials = new GreyboxMaterials(() => document.createElement("canvas") as GridCanvas);
    const world = buildWorldMesh(cmap, (name) => materials.get(name));
    this.materials = materials;
    this.world = world;
    this.scene.add(world.group);
  }

  /** Frees the world's geometry, materials and textures. */
  unloadMap(): void {
    if (this.world !== null) {
      this.scene.remove(this.world.group);
      this.world.dispose();
      this.world = null;
    }
    this.materials?.dispose();
    this.materials = null;
  }

  get triangles(): number {
    return this.world?.triangles ?? 0;
  }

  /** Draw calls of the last frame. */
  get drawCalls(): number {
    return this.gl.info.render.calls;
  }

  /** Draws a frame from the camera's pose (the caller filled it) at `cl_fov`. */
  render(fovDeg: number): void {
    const c = this.canvas;
    const w = c.clientWidth;
    const h = c.clientHeight;
    const size = this.gl.getPixelRatio();
    if (c.width !== Math.floor(w * size) || c.height !== Math.floor(h * size)) {
      this.gl.setSize(w, h, false);
    }
    this.view.resize(w, h, fovDeg);
    this.view.apply();
    this.gl.render(this.scene, this.view.camera);
  }

  dispose(): void {
    this.unloadMap();
    this.debug.dispose();
    this.gl.dispose();
  }
}
