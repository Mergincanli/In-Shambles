import {
  buildCollisionWorld,
  degreesToU16,
  TEAM_1,
  TEAM_2,
  TRACE_EPSILON,
  vec3,
} from "@game/shared";
import { describe, expect, it } from "vitest";
import { assignTeam, SPAWN_CLASSNAME, SpawnRotation } from "../../src/match/spawns";
import { loadMap } from "./fixtures";

const arena = loadMap("arena_greybox");
const arenaWorld = buildCollisionWorld(arena);
const points = arena.entities.filter((e) => e.classname === SPAWN_CLASSNAME);

describe("SpawnRotation (M3 design §2.4, D-034)", () => {
  it("holds arena_greybox's 16 info_player_start in cmap order, raised ε, with their yaws", () => {
    const warnings: string[] = [];
    const r = new SpawnRotation(arena, arenaWorld, (_level, msg) => warnings.push(msg));
    expect(r.count).toBe(16);
    expect(points).toHaveLength(16);
    const o = vec3();
    for (let i = 0; i < 16; i++) {
      const e = points[i];
      const at = e?.origin ?? [Number.NaN, Number.NaN, Number.NaN];
      r.origin(i, o);
      expect(Array.from(o)).toEqual([at[0], at[1], at[2] + TRACE_EPSILON]);
      expect(r.yaw(i)).toBe(degreesToU16(e?.angles?.[1] ?? 0));
    }
    // Every point is clear for a standing hull; the team spawns are not used (M7).
    expect(warnings).toEqual([]);
  });

  it("takes the points round-robin: the 17th spawn wraps to the first", () => {
    const r = new SpawnRotation(arena, arenaWorld, () => {});
    const taken: number[] = [];
    for (let i = 0; i < 17; i++) {
      expect(r.next).toBe(i % 16);
      taken.push(r.take());
    }
    expect(taken).toEqual([...Array.from({ length: 16 }, (_, i) => i), 0]);
    // Deterministic: a second rotation over the same map takes the same order.
    const again = new SpawnRotation(arena, arenaWorld, () => {});
    expect(Array.from({ length: 17 }, () => again.take())).toEqual(taken);
  });

  it("refuses a map with no info_player_start", () => {
    const bare = { ...arena, entities: arena.entities.filter((e) => !points.includes(e)) };
    expect(() => new SpawnRotation(bare, arenaWorld, () => {})).toThrow(/no info_player_start/);
  });

  it("warns about a point inside solid", () => {
    const first = points[0];
    if (first?.origin === undefined) throw new Error("no origin");
    // Half the hull inside the yard floor.
    const sunk = {
      ...first,
      origin: [first.origin[0], first.origin[1], first.origin[2] - 24] as const,
    };
    const map = { ...arena, entities: [sunk, ...arena.entities.filter((e) => e !== first)] };
    const warnings: string[] = [];
    new SpawnRotation(map, arenaWorld, (level, msg) => warnings.push(`${level} ${msg}`));
    expect(warnings).toEqual([`warn map arena_greybox: ${SPAWN_CLASSNAME} 0 is inside solid`]);
  });
});

describe("assignTeam (M3 design §2.4, D-034)", () => {
  it("picks the team with fewer active players, team 1 on a tie", () => {
    expect(assignTeam(0, 0)).toBe(TEAM_1);
    expect(assignTeam(1, 0)).toBe(TEAM_2);
    expect(assignTeam(1, 1)).toBe(TEAM_1);
    expect(assignTeam(3, 5)).toBe(TEAM_1);
    expect(assignTeam(6, 5)).toBe(TEAM_2);
  });
});
