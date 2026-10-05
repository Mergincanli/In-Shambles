import { type Vec3, vec3 } from "../math/vec3";

/**
 * Player hulls relative to the origin, per docs/03 §2 (the table there carries no
 * FACT/INFERRED/ESTIMATE label). Crouching and sliding shrink the box from the top, so both
 * states share HULL_MINS.
 *
 * Shared constants that are never written: copy into a scratch vector before adjusting one.
 */
export const HULL_MINS: Vec3 = vec3(-15, -15, -24);
export const HULL_STANDING_MAXS: Vec3 = vec3(15, 15, 32);
export const HULL_CROUCHED_MAXS: Vec3 = vec3(15, 15, 16);
