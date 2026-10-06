import { type Vec3, vec3 } from "../../math/vec3";
import { TraceResult } from "../../world/trace";
import { ENTITY_NONE } from "../entity";
import { HULL_MINS, HULL_STANDING_MAXS } from "../hull";

/**
 * pmove's named scratch (D-016: per-module, never a shared pool), allocated once at load. pmove
 * and its step modules run one player at a time and never re-enter each other, so one set is
 * enough; nothing here survives a tick, which starts again from `PlayerState`.
 */

/** View basis from `angleVectors` for this tick's cmd angles. */
export const viewForward: Vec3 = vec3();
export const viewRight: Vec3 = vec3();
export const viewUp: Vec3 = vec3();

/** `cmdScale` output: the cmd's move axes times the docs/03 §4.1 scale. */
export const moveAxes: Vec3 = vec3();
export const wishVel: Vec3 = vec3();
export const wishDir: Vec3 = vec3();

/** Contact planes the slide move clips against (docs/03 §4.8 tracks up to 5). */
export const MAX_CLIP_PLANES = 5;
export const clipPlanes: readonly Vec3[] = [vec3(), vec3(), vec3(), vec3(), vec3()];

/** Two traces, so a step-slide can keep one result while it probes with the other. */
export const traceA = new TraceResult();
export const traceB = new TraceResult();

/** What the ground trace found (docs/03 §4.10), recomputed every tick from the start origin. */
export class GroundInfo {
  /** The probe hit something within pm_groundTraceDist. */
  hit = false;
  /** The hit plane is walkable (normal z ≥ pm_minWalkNormal). */
  walkable = false;
  readonly normal: Vec3 = vec3();
  surfaceFlags = 0;
  contents = 0;
  entity = ENTITY_NONE;
}
export const ground = new GroundInfo();

/** The hull for this tick; the crouch pre-check is the only writer (M2 design §0). */
export class HullRefs {
  mins: Vec3 = HULL_MINS;
  maxs: Vec3 = HULL_STANDING_MAXS;
}
export const hull = new HullRefs();

/** The tick's start origin: `snapOrigin`'s fallback. */
export const prevOrigin: Vec3 = vec3();
/** Normal of the ladder face the contact probe found. */
export const ladderNormal: Vec3 = vec3();
