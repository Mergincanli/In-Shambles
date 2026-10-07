import { readFileSync } from "node:fs";
import {
  buildCollisionWorld,
  type Cmap,
  type CollisionWorld,
  decodeCmap,
  degreesToU16,
} from "@game/shared";
import { COURSE_MAP_DIR, courseFileName } from "../greybox/courses";
import { fromRoot } from "../paths";

/**
 * The committed greybox courses as the game loads them (D-025): the scenario runner, the course
 * fixture tests and the feel report all read content/maps through here, so they test the files
 * that ship rather than a fresh compile.
 */

export type P3 = readonly [number, number, number];

export interface LoadedCourse {
  readonly name: string;
  readonly cmap: Cmap;
  readonly world: CollisionWorld;
}

/** A named place on a course (an `info_target` with a `targetname`). */
export interface CourseAnchor {
  readonly name: string;
  readonly origin: P3;
  /** Yaw in degrees from the entity's angles (0 when it has none). */
  readonly yawDegrees: number;
}

export function coursePath(name: string): string {
  return fromRoot(...COURSE_MAP_DIR, courseFileName(name));
}

const cache = new Map<string, LoadedCourse>();

/** The committed file, decoded with hash verification and built into a world; cached by name. */
export function loadCourse(name: string): LoadedCourse {
  let course = cache.get(name);
  if (course === undefined) {
    const cmap = decodeCmap(new Uint8Array(readFileSync(coursePath(name))));
    course = { name, cmap, world: buildCollisionWorld(cmap) };
    cache.set(name, course);
  }
  return course;
}

/** Every anchor by name. A name may repeat (the fixture tests check it doesn't). */
export function courseAnchors(cmap: Cmap): Map<string, CourseAnchor[]> {
  const out = new Map<string, CourseAnchor[]>();
  for (const e of cmap.entities) {
    if (e.classname !== "info_target") continue;
    const name = e.props.targetname ?? "";
    const list = out.get(name) ?? [];
    if (e.origin !== undefined) {
      list.push({ name, origin: e.origin, yawDegrees: e.angles?.[1] ?? 0 });
    }
    out.set(name, list);
  }
  return out;
}

/** The one anchor called `name`; throws when the course has none or several. */
export function courseAnchor(course: LoadedCourse, name: string): CourseAnchor {
  const list = courseAnchors(course.cmap).get(name) ?? [];
  if (list.length !== 1) {
    throw new Error(`${course.name}: expected one anchor ${name}, found ${list.length}`);
  }
  return list[0] as CourseAnchor;
}

/** The anchor's yaw as a u16 cmd angle. */
export function anchorYawU16(anchor: CourseAnchor): number {
  return degreesToU16(anchor.yawDegrees);
}
