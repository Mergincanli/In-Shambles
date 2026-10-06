import type { Cmap } from "@game/shared";
import { arenaGreybox } from "./arena_greybox";
import { fallTower } from "./fall_tower";
import { jumpLab } from "./jump_lab";
import { movementLab } from "./movement_lab";
import { slideLab } from "./slide_lab";

/**
 * The greybox courses (docs/07 §3), in a fixed order. `pnpm greybox` writes each to
 * content/maps/<name>.cmap, and the course tests fail when a committed file is stale.
 */

export interface Course {
  /** The map name, which is also the file name. */
  readonly name: string;
  /** Builds and compiles the course afresh on every call. */
  readonly build: () => Cmap;
}

export const COURSES: readonly Course[] = [
  { name: "movement_lab", build: movementLab },
  { name: "jump_lab", build: jumpLab },
  { name: "slide_lab", build: slideLab },
  { name: "fall_tower", build: fallTower },
  { name: "arena_greybox", build: arenaGreybox },
];

/** Where the compiled courses live, from the repo root. */
export const COURSE_MAP_DIR: readonly string[] = ["content", "maps"];

export function courseFileName(name: string): string {
  return `${name}.cmap`;
}
