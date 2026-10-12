import {
  type Cmap,
  type CollisionWorld,
  degreesToU16,
  HULL_MINS,
  HULL_STANDING_MAXS,
  MASK_PLAYERSOLID,
  positionTest,
  TEAM_1,
  TEAM_2,
  TRACE_EPSILON,
  type Vec3,
  vec3,
} from "@game/shared";
import type { MatchLog } from "./host";

/** Classname of the free-for-all spawn points every player uses in M3 (docs/07 §3, D-034). */
export const SPAWN_CLASSNAME = "info_player_start";

/**
 * The map's spawn points in cmap order and a round-robin over them (M3 design §2.4, D-034): each
 * spawn takes the next point, and the one after the last wraps to the first. Players are not
 * solid to each other until M4 (docs/03 §5.9), so a wrapped spawn that overlaps is harmless.
 * Team spawns come with the modes (M7). Deterministic: the rotation depends only on the order of
 * spawns, never on a clock.
 *
 * Origins are raised by TRACE_EPSILON at construction to the D-017 rest height, floor + 1/32 u,
 * as a landed player rests: with its feet exactly on the floor a fresh spawn would meet a steep
 * wedge's toe as a wall (D-023 "Steep toes").
 */
export class SpawnRotation {
  /** Spawn points. */
  readonly count: number;
  /** xyz per point, raised to the rest height. */
  private readonly origins: Float64Array;
  /** u16 yaw per point. */
  private readonly yaws: Uint16Array;
  private nextIndex = 0;

  constructor(cmap: Cmap, world: CollisionWorld, log: MatchLog) {
    const points = cmap.entities.filter(
      (e) => e.classname === SPAWN_CLASSNAME && e.origin !== undefined,
    );
    if (points.length === 0) {
      throw new Error(`map ${cmap.name} has no ${SPAWN_CLASSNAME} with an origin`);
    }
    this.count = points.length;
    this.origins = new Float64Array(points.length * 3);
    this.yaws = new Uint16Array(points.length);
    const o = vec3();
    for (let i = 0; i < points.length; i++) {
      const e = points[i] as (typeof points)[number];
      const at = e.origin as readonly [number, number, number];
      o[0] = at[0];
      o[1] = at[1];
      o[2] = at[2] + TRACE_EPSILON;
      this.origins.set(o, i * 3);
      this.yaws[i] = degreesToU16(e.angles?.[1] ?? 0);
      if (!positionTest(world, o, HULL_MINS, HULL_STANDING_MAXS, MASK_PLAYERSOLID)) {
        log("warn", `map ${cmap.name}: ${SPAWN_CLASSNAME} ${i} is inside solid`);
      }
    }
  }

  /** The point the next spawn takes (0 … count − 1). */
  get next(): number {
    return this.nextIndex;
  }

  /** Takes the next point: returns its index and moves the rotation on. */
  take(): number {
    const i = this.nextIndex;
    this.nextIndex = (i + 1) % this.count;
    return i;
  }

  /** Point `i`'s origin (raised to the rest height) into `out`. */
  origin(i: number, out: Vec3): Vec3 {
    const o = this.origins;
    out[0] = o[i * 3] as number;
    out[1] = o[i * 3 + 1] as number;
    out[2] = o[i * 3 + 2] as number;
    return out;
  }

  /** Point `i`'s yaw, u16. */
  yaw(i: number): number {
    return this.yaws[i] as number;
  }
}

/**
 * The team a joining player gets (M3 design §2.4, D-034): the one with fewer active players, team
 * 1 on a tie. Teams are only cosmetic until M7 (capsule colours), and nobody is moved when the
 * balance drifts later.
 */
export function assignTeam(team1: number, team2: number): number {
  return team2 < team1 ? TEAM_2 : TEAM_1;
}
