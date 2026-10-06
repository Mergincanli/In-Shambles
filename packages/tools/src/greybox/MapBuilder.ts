import {
  BrushError,
  boxPlanes,
  type Cmap,
  type CmapData,
  type CmapEntity,
  type CmapVec3,
  CONTENTS_LADDER,
  CONTENTS_NODRAW,
  CONTENTS_PLAYERCLIP,
  CONTENTS_SOLID,
  CONTENTS_TRIGGER,
  CONTENTS_WATER,
  decodeCmap,
  ORIGIN_LIMIT,
  rotatedBoxPlanes,
  SURF_LADDER,
  type Triple,
  type WedgeRise,
  wedgePlanes,
} from "@game/shared";
import {
  assembleBrushes,
  type CompiledBrush,
  compileBrush,
  GREYBOX_COMPILER_NAME,
  GREYBOX_COMPILER_VERSION,
  GreyboxError,
} from "./brushCompiler";
import { encodeCmap } from "./cmapEncode";

/**
 * The greybox map builder (docs/07 §3): test courses written as TypeScript calls, compiled to a
 * cmap. Every primitive builds and checks its brushes at once, so a bad shape throws at the call
 * that made it, and a call that throws adds nothing. Brushes and entities keep call order, so the
 * same calls always give the same file.
 *
 * Entity angles are the cmap `angles` field, [pitch, yaw, roll] in degrees (docs/07 §2, D-021),
 * with pitch and roll 0: a yaw of 0 faces +x and 90 faces +y.
 */

/** A horizontal direction: the way stairs and slopes climb, or the side a ladder is on. */
export type Direction = WedgeRise;

export const MATERIAL_FLOOR = "grey/floor";
export const MATERIAL_WALL = "grey/wall";
export const MATERIAL_WATER = "grey/water";
export const MATERIAL_CLIP = "tool/clip";
export const MATERIAL_TRIGGER = "tool/trigger";
export const MATERIAL_NODRAW = "tool/nodraw";
export const MATERIAL_LADDER = "tool/ladder";
/** The rung texture ladder() puts on the climbable face (D-024). */
export const MATERIAL_LADDER_FACE = "grey/ladder";

/** The volume kinds volume() takes: non-solid contents, by docs/07 §2 name. */
export const VOLUME_CONTENTS = {
  WATER: CONTENTS_WATER,
  LADDER: CONTENTS_LADDER,
  PLAYERCLIP: CONTENTS_PLAYERCLIP,
  TRIGGER: CONTENTS_TRIGGER,
  NODRAW: CONTENTS_NODRAW,
} as const;
export type VolumeKind = keyof typeof VOLUME_CONTENTS;

export type SpawnClass = "info_player_start" | "info_spawn_red" | "info_spawn_blue";

/** Applies to every face of the brush or brushes a call makes. */
export interface BrushStyle {
  /** Default: from the contents (water, tool textures), else floor or wall grey. */
  readonly material?: string;
  /** SURF_* bits, such as a footstep material or SURF_SLICK. Default 0. */
  readonly surfaceFlags?: number;
}

export interface BoxOptions extends BrushStyle {
  readonly min: Triple;
  readonly max: Triple;
  /** CONTENTS_* bits. Default CONTENTS_SOLID. */
  readonly contents?: number;
}

export interface StairsOptions extends BrushStyle {
  /** The bottom of the first riser, centred across the width. */
  readonly origin: Triple;
  readonly steps: number;
  readonly stepHeight: number;
  readonly stepDepth: number;
  readonly width: number;
  /** The way the stairs climb. Default "+x". */
  readonly direction?: Direction;
}

export interface RampOptions extends BrushStyle {
  /** Centre of one end edge; the other end is `to`. They may differ along one horizontal axis. */
  readonly from: Triple;
  readonly to: Triple;
  readonly width: number;
}

export interface SlopeOptions extends BrushStyle {
  /** Centre of the low edge. */
  readonly from: Triple;
  /** Horizontal length. */
  readonly run: number;
  /** The slope's normal z, in (0, 1): 0.7 is the walkable limit (docs/03). */
  readonly normalZ: number;
  readonly width: number;
  /** The way the slope climbs. Default "+x". */
  readonly direction?: Direction;
}

export interface WallOptions extends BrushStyle {
  readonly min: Triple;
  readonly max: Triple;
}

export interface RotatedBoxOptions extends BrushStyle {
  readonly center: Triple;
  readonly halfExtents: Triple;
  /** Cosine and sine of the rotation about +Z: closed forms or dtrig values, never Math.cos. */
  readonly cos: number;
  readonly sin: number;
  /** CONTENTS_* bits. Default CONTENTS_SOLID. */
  readonly contents?: number;
}

export interface VolumeOptions {
  readonly min: Triple;
  readonly max: Triple;
  readonly material?: string;
}

export interface LadderOptions {
  /** The solid wall the ladder is fixed to. */
  readonly wallMin: Triple;
  readonly wallMax: Triple;
  /** The side of the wall the ladder is on: that face gets SURF_LADDER and the rung texture. */
  readonly face: Direction;
  /** The material of the wall's other faces. Default MATERIAL_WALL. */
  readonly material?: string;
}

export interface TimerOptions {
  readonly min: Triple;
  readonly max: Triple;
}

type Triple3 = [number, number, number];

/** snake_case ids: map names and anchor names. */
const ID = /^[a-z0-9_]+$/;

/** Entity prop keys: snake_case starting with a letter, which also keeps out "__proto__". */
const PROP_KEY = /^[a-z][a-z0-9_]*$/;

const DIRECTIONS: readonly string[] = ["+x", "-x", "+y", "-y"];

/** The brushes one call makes, compiled but not yet added: a call adds all of them or none. */
type Batch = CompiledBrush[];

/** Plane index of the box face on the named side (boxPlanes order −x, +x, −y, +y). */
function sideFace(side: Direction): number {
  switch (side) {
    case "-x":
      return 0;
    case "+x":
      return 1;
    case "-y":
      return 2;
    case "+y":
      return 3;
  }
}

function directionAxis(direction: Direction): number {
  return direction === "+x" || direction === "-x" ? 0 : 1;
}

function directionSign(direction: Direction): number {
  return direction === "+x" || direction === "+y" ? 1 : -1;
}

function defaultMaterial(contents: number, solid: string): string {
  if ((contents & CONTENTS_PLAYERCLIP) !== 0) return MATERIAL_CLIP;
  if ((contents & CONTENTS_TRIGGER) !== 0) return MATERIAL_TRIGGER;
  if ((contents & CONTENTS_NODRAW) !== 0) return MATERIAL_NODRAW;
  if ((contents & CONTENTS_SOLID) !== 0) return solid;
  if ((contents & CONTENTS_WATER) !== 0) return MATERIAL_WATER;
  if ((contents & CONTENTS_LADDER) !== 0) return MATERIAL_LADDER;
  return solid;
}

export class MapBuilder {
  readonly name: string;
  private readonly brushes: CompiledBrush[] = [];
  private readonly entities: CmapEntity[] = [];
  private readonly anchors = new Set<string>();

  constructor(name: string) {
    if (!ID.test(name))
      throw new GreyboxError(`map name ${JSON.stringify(name)} is not snake_case`);
    this.name = name;
  }

  /** Brushes added so far; the next one gets this index (entity `brushes` refer to it). */
  get brushCount(): number {
    return this.brushes.length;
  }

  /** An axis-aligned box. */
  box(options: BoxOptions): number {
    const min = this.point(options.min, "box min");
    const max = this.point(options.max, "box max");
    const batch: Batch = [];
    const planes = this.boxShape(batch, "box", min, max);
    const index = this.styled(batch, "box", planes, options.contents ?? CONTENTS_SOLID, options);
    this.commit(batch);
    return index;
  }

  /**
   * Solid stairs: one column per step, step i covering depth [i, i + 1)·stepDepth from the origin
   * and rising (i + 1)·stepHeight above it. Returns the z of the top step.
   */
  stairs(options: StairsOptions): number {
    const { steps, stepHeight, stepDepth, width } = options;
    if (!Number.isInteger(steps) || steps < 1) {
      throw this.error(`stairs: steps ${steps} must be a positive integer`);
    }
    this.positive(stepHeight, "stairs stepHeight");
    this.positive(stepDepth, "stairs stepDepth");
    this.positive(width, "stairs width");
    const origin = this.point(options.origin, "stairs origin");
    const direction = this.direction(options.direction ?? "+x", "stairs direction");
    const axis = directionAxis(direction);
    const sign = directionSign(direction);
    const across = 1 - axis;
    const batch: Batch = [];
    for (let i = 0; i < steps; i++) {
      const near = origin[axis] + sign * i * stepDepth;
      const far = origin[axis] + sign * (i + 1) * stepDepth;
      const min = [0, 0, origin[2]];
      const max = [0, 0, origin[2] + (i + 1) * stepHeight];
      min[axis] = Math.min(near, far);
      max[axis] = Math.max(near, far);
      min[across] = origin[across] - width / 2;
      max[across] = origin[across] + width / 2;
      const kind = `stairs step ${i}`;
      const planes = this.boxShape(batch, kind, min as Triple3, max as Triple3);
      this.styled(batch, kind, planes, CONTENTS_SOLID, options);
    }
    this.commit(batch);
    return origin[2] + steps * stepHeight;
  }

  /**
   * A solid wedge from `from` to `to`, which may differ along x or y but not both: a ramp turned
   * off an axis would need edge bevels, which arrive with mapc in M5. The floor of the wedge is
   * the lower end's z. Returns the higher end's z.
   */
  ramp(options: RampOptions): number {
    const from = this.point(options.from, "ramp from");
    const to = this.point(options.to, "ramp to");
    this.positive(options.width, "ramp width");
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    if (dx !== 0 && dy !== 0) {
      throw this.error(
        `ramp from (${from.join(", ")}) to (${to.join(", ")}) is not aligned to an axis; off-axis ramps need edge bevels (M5)`,
      );
    }
    if (dx === 0 && dy === 0) throw this.error("ramp: from and to need a horizontal run");
    if (to[2] === from[2]) throw this.error("ramp: from and to are level; use box()");
    const axis = dx !== 0 ? 0 : 1;
    const across = 1 - axis;
    const low = to[2] > from[2] ? from : to;
    const high = low === from ? to : from;
    const rise: Direction =
      axis === 0 ? (high[0] > low[0] ? "+x" : "-x") : high[1] > low[1] ? "+y" : "-y";
    const min = [0, 0, low[2]];
    const max = [0, 0, high[2]];
    min[axis] = Math.min(from[axis], to[axis]);
    max[axis] = Math.max(from[axis], to[axis]);
    min[across] = from[across] - options.width / 2;
    max[across] = from[across] + options.width / 2;
    const batch: Batch = [];
    const planes = this.wedgeShape(batch, "ramp", min as Triple3, max as Triple3, rise);
    this.styled(batch, "ramp", planes, CONTENTS_SOLID, options);
    this.commit(batch);
    return high[2];
  }

  /**
   * A solid wedge whose slope has the given normal z: rise = run·√(1 − nz²)/nz, so after f32
   * rounding the stored normal z is Math.fround(normalZ). Returns the compiled wedge's top (its +z
   * bound): the crest of the f32 planes rounded up to an f32, not from z + rise, which can sit
   * several f32 steps lower far from the origin. A platform with this top is never below the
   * crest and at most one f32 step above it.
   */
  slope(options: SlopeOptions): number {
    const from = this.point(options.from, "slope from");
    const { run, normalZ: nz, width } = options;
    this.positive(run, "slope run");
    this.positive(width, "slope width");
    if (!(nz > 0 && nz < 1)) throw this.error(`slope: normalZ ${nz} must be in (0, 1)`);
    const rise = (run * Math.sqrt(1 - nz * nz)) / nz;
    const direction = this.direction(options.direction ?? "+x", "slope direction");
    const axis = directionAxis(direction);
    const sign = directionSign(direction);
    const across = 1 - axis;
    const min = [0, 0, from[2]];
    const max = [0, 0, from[2] + rise];
    min[axis] = sign > 0 ? from[axis] : from[axis] - run;
    max[axis] = sign > 0 ? from[axis] + run : from[axis];
    min[across] = from[across] - width / 2;
    max[across] = from[across] + width / 2;
    const batch: Batch = [];
    const planes = this.wedgeShape(batch, "slope", min as Triple3, max as Triple3, direction);
    this.styled(batch, "slope", planes, CONTENTS_SOLID, options);
    this.commit(batch);
    return (batch[0] as CompiledBrush).built.bounds[5] as number;
  }

  /** An axis-aligned solid box in wall grey. */
  wall(options: WallOptions): number {
    const min = this.point(options.min, "wall min");
    const max = this.point(options.max, "wall max");
    const batch: Batch = [];
    const planes = this.boxShape(batch, "wall", min, max);
    const index = this.styled(batch, "wall", planes, CONTENTS_SOLID, options, MATERIAL_WALL);
    this.commit(batch);
    return index;
  }

  /** A box rotated about +Z (kick lanes): exact with axial bevels, so no trig is needed here. */
  rotatedBox(options: RotatedBoxOptions): number {
    const center = this.point(options.center, "rotatedBox center");
    const half = this.point(options.halfExtents, "rotatedBox halfExtents");
    const batch: Batch = [];
    let planes: Float64Array;
    try {
      planes = rotatedBoxPlanes(center, half, options.cos, options.sin);
    } catch (e) {
      throw this.shapeError(e, batch, "rotatedBox");
    }
    const contents = options.contents ?? CONTENTS_SOLID;
    const index = this.styled(batch, "rotatedBox", planes, contents, options, MATERIAL_WALL);
    this.commit(batch);
    return index;
  }

  /** A non-solid volume box: water renders with a water material, the others are invisible. */
  volume(kind: VolumeKind, options: VolumeOptions): number {
    if (!Object.hasOwn(VOLUME_CONTENTS, kind)) {
      throw this.error(`volume: unknown kind ${JSON.stringify(kind)}`);
    }
    const contents = VOLUME_CONTENTS[kind];
    const min = this.point(options.min, `${kind} volume min`);
    const max = this.point(options.max, `${kind} volume max`);
    const batch: Batch = [];
    const planes = this.boxShape(batch, `${kind} volume`, min, max);
    const index = this.styled(batch, `${kind} volume`, planes, contents, options, MATERIAL_WALL);
    this.commit(batch);
    return index;
  }

  /**
   * A ladder: the solid wall with SURF_LADDER and the MATERIAL_LADDER_FACE rung texture on the
   * named face. The movement code reads only that face (D-024), so no LADDER volume is emitted;
   * CONTENTS_LADDER stays reserved (volume("LADDER") still builds one).
   */
  ladder(options: LadderOptions): void {
    const wallMin = this.point(options.wallMin, "ladder wallMin");
    const wallMax = this.point(options.wallMax, "ladder wallMax");
    const side = this.direction(options.face, "ladder face");
    const batch: Batch = [];
    const planes = this.boxShape(batch, "ladder wall", wallMin, wallMax);
    const flags = [0, 0, 0, 0, 0, 0];
    const face = sideFace(side);
    flags[face] = SURF_LADDER;
    const material = options.material ?? MATERIAL_WALL;
    const materials = [material, material, material, material, material, material];
    materials[face] = MATERIAL_LADDER_FACE;
    this.compileInto(batch, "ladder wall", planes, CONTENTS_SOLID, materials, flags);
    this.commit(batch);
  }

  /** A spawn point; yaw in degrees. */
  spawn(
    classname: SpawnClass,
    origin: Triple,
    yaw: number,
    props?: Readonly<Record<string, string>>,
  ): void {
    if (
      classname !== "info_player_start" &&
      classname !== "info_spawn_red" &&
      classname !== "info_spawn_blue"
    ) {
      throw this.error(`spawn: ${JSON.stringify(classname)} is not a spawn class`);
    }
    this.entities.push({
      classname,
      origin: this.origin(origin, `${classname} origin`),
      angles: [0, this.finite(yaw, `${classname} yaw`), 0],
      props: this.props(props),
    });
  }

  /** A Movement Trials timer zone: an invisible TRIGGER brush and its info_timer_start/stop. */
  timer(kind: "start" | "stop", options: TimerOptions): void {
    if (kind !== "start" && kind !== "stop")
      throw this.error(`timer: unknown kind ${JSON.stringify(kind)}`);
    const min = this.point(options.min, `timer ${kind} min`);
    const max = this.point(options.max, `timer ${kind} max`);
    const batch: Batch = [];
    const planes = this.boxShape(batch, `timer ${kind}`, min, max);
    const brush = this.styled(batch, `timer ${kind}`, planes, CONTENTS_TRIGGER, {});
    this.commit(batch);
    this.entities.push({ classname: `info_timer_${kind}`, props: {}, brushes: [brush] });
  }

  /**
   * A named place for tests (M1 design I): an info_target whose targetname is `name`, so tests
   * say "gap_96_takeoff" rather than coordinates. Names are unique per map.
   */
  anchor(name: string, origin: Triple, yaw?: number): void {
    if (!ID.test(name)) throw this.error(`anchor name ${JSON.stringify(name)} is not snake_case`);
    if (this.anchors.has(name)) throw this.error(`anchor ${JSON.stringify(name)} exists already`);
    const entity: {
      classname: string;
      origin: CmapVec3;
      angles?: CmapVec3;
      props: Record<string, string>;
    } = {
      classname: "info_target",
      origin: this.origin(origin, `anchor ${name} origin`),
      props: { targetname: name },
    };
    if (yaw !== undefined) entity.angles = [0, this.finite(yaw, `anchor ${name} yaw`), 0];
    this.anchors.add(name);
    this.entities.push(entity);
  }

  /**
   * The compiled map, exactly as a loader reads it: the data goes through encodeCmap and
   * decodeCmap, so it is fully validated and carries its content hash. encodeCmap of the result
   * gives the file bytes. Compiling does not change the builder.
   */
  compile(): Cmap {
    if (this.brushes.length === 0) throw this.error("a map needs at least one brush");
    const geometry = assembleBrushes(this.brushes);
    const data: CmapData = {
      name: this.name,
      bounds: geometry.bounds,
      compiler: { name: GREYBOX_COMPILER_NAME, version: GREYBOX_COMPILER_VERSION },
      entities: this.entities,
      materials: geometry.materials,
      units: "inch",
      up: "z",
      planes: geometry.planes,
      planeSurfaceFlags: geometry.planeSurfaceFlags,
      planeMaterial: geometry.planeMaterial,
      brushes: geometry.brushes,
      surfaces: geometry.surfaces,
      vertices: geometry.vertices,
      indices: geometry.indices,
    };
    return decodeCmap(encodeCmap(data));
  }

  /** Compiles a brush as the next one after the batch; errors carry its label. */
  private compileInto(
    batch: Batch,
    kind: string,
    planes: Float64Array,
    contents: number,
    materials: string[],
    surfaceFlags: number[],
  ): number {
    const index = this.brushes.length + batch.length;
    const label = this.label(index, kind);
    batch.push(compileBrush({ label, planes, contents, materials, surfaceFlags }));
    return index;
  }

  /** compileInto with one material and one set of surface flags on every face. */
  private styled(
    batch: Batch,
    kind: string,
    planes: Float64Array,
    contents: number,
    style: BrushStyle,
    solid = MATERIAL_FLOOR,
  ): number {
    const count = planes.length / 4;
    const material = style.material ?? defaultMaterial(contents, solid);
    const flags = style.surfaceFlags ?? 0;
    const materials: string[] = [];
    const surfaceFlags: number[] = [];
    for (let i = 0; i < count; i++) {
      materials.push(material);
      surfaceFlags.push(flags);
    }
    return this.compileInto(batch, kind, planes, contents, materials, surfaceFlags);
  }

  /** Adds a call's brushes once all of them compiled. */
  private commit(batch: Batch): void {
    for (let i = 0; i < batch.length; i++) this.brushes.push(batch[i] as CompiledBrush);
  }

  private label(index: number, kind: string): string {
    return `${this.name} brush ${index} (${kind})`;
  }

  /** A shape constructor's BrushError, named after the brush it was building. */
  private shapeError(e: unknown, batch: Batch, kind: string): unknown {
    if (!(e instanceof BrushError)) return e;
    return new GreyboxError(
      `${this.label(this.brushes.length + batch.length, kind)}: ${e.message}`,
    );
  }

  private boxShape(batch: Batch, kind: string, min: Triple, max: Triple): Float64Array {
    try {
      return boxPlanes(min, max);
    } catch (e) {
      throw this.shapeError(e, batch, kind);
    }
  }

  private wedgeShape(
    batch: Batch,
    kind: string,
    min: Triple,
    max: Triple,
    rise: Direction,
  ): Float64Array {
    try {
      return wedgePlanes(min, max, rise);
    } catch (e) {
      throw this.shapeError(e, batch, kind);
    }
  }

  private error(message: string): GreyboxError {
    return new GreyboxError(`${this.name}: ${message}`);
  }

  private finite(x: number, what: string): number {
    if (typeof x !== "number" || !Number.isFinite(x))
      throw this.error(`${what} must be a finite number`);
    return x + 0;
  }

  private positive(x: number, what: string): void {
    if (!(this.finite(x, what) > 0)) throw this.error(`${what} must be positive`);
  }

  private point(p: Triple, what: string): Triple3 {
    if (!Array.isArray(p) || p.length !== 3) throw this.error(`${what} must be 3 numbers`);
    return [this.finite(p[0], what), this.finite(p[1], what), this.finite(p[2], what)];
  }

  /** An entity origin: a point inside the ±ORIGIN_LIMIT world that brushes are held to. */
  private origin(p: Triple, what: string): Triple3 {
    const o = this.point(p, what);
    for (let k = 0; k < 3; k++) {
      if (Math.abs(o[k] as number) > ORIGIN_LIMIT) {
        throw this.error(`${what} is outside the ±${ORIGIN_LIMIT} u world limit`);
      }
    }
    return o;
  }

  /** Checked at run time too, since courses may come from untyped data. */
  private direction(d: Direction, what: string): Direction {
    if (!DIRECTIONS.includes(d)) {
      throw this.error(`${what} ${JSON.stringify(d)} is not one of "+x", "-x", "+y", "-y"`);
    }
    return d;
  }

  private props(props: Readonly<Record<string, string>> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (props === undefined) return out;
    for (const key of Object.keys(props)) {
      if (!PROP_KEY.test(key)) {
        throw this.error(`entity prop key ${JSON.stringify(key)} is not snake_case`);
      }
      const value = props[key];
      if (typeof value !== "string")
        throw this.error(`entity prop ${JSON.stringify(key)} must be a string`);
      out[key] = value;
    }
    return out;
  }
}
