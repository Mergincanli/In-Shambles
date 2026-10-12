import { type CmdSampler, RandomWalk, RouteInput } from "@game/client/net";

/**
 * The bots' behaviours (M3 design §2.15, D-036): 60% strafe-jump routes, 40% random walks. A
 * route is a closed list of waypoints per map; a map without one gets random walks only.
 */

/**
 * arena_greybox's yard ring (x ±900, y ±560, the design's ring) with its corners cut at 45°, so
 * a strafe-jumping bot turns twice by 45° instead of once by 90° and keeps its speed. It passes
 * south of the covered corridor and outside the centre platform, its crates and the low walls,
 * and every spawn point sees its nearest waypoint across open floor (route tests: laps from all
 * 16 spawn points, under 5% of the time stuck).
 */
export const ARENA_RING: readonly number[] = [
  900, -300, 900, 300, 650, 560, -650, 560, -900, 300, -900, -300, -650, -560, 650, -560,
];

/** Waypoints (x, y pairs, u) of each map's route. */
export const BOT_ROUTES: Readonly<Record<string, readonly number[]>> = {
  arena_greybox: ARENA_RING,
};

/** Of every 5 bots, this many run the route (60%); the rest random-walk. */
const ROUTE_SHARE_OF_5 = 3;

/** The route of `map`, or null when it has none. */
export function routeFor(map: string): readonly number[] | null {
  return Object.hasOwn(BOT_ROUTES, map) ? (BOT_ROUTES[map] as readonly number[]) : null;
}

/** Whether bot `index` runs the route (60%) or walks (40%), on a map with a route. */
export function runsRoute(index: number): boolean {
  return index % 5 < ROUTE_SHARE_OF_5;
}

/**
 * Bot `index`'s cmd source on `map`, seeded by `seed` and its index, so a run's behaviours are a
 * pure function of the seed. Each bot idles a little longer than the one before (1.5 s + 7 ticks
 * per bot), so the clock settles before it moves and the joins don't all set off at once.
 */
export function createBotInput(map: string, index: number, seed: number): CmdSampler {
  const idleTicks = 90 + 7 * index;
  const botSeed = (seed + Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  const route = routeFor(map);
  if (route !== null && runsRoute(index)) return new RouteInput(route, botSeed, { idleTicks });
  return new RandomWalk(botSeed, { idleTicks });
}
