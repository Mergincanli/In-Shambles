import { type Vec3, vec3 } from "../math/vec3";

/**
 * Player hulls relative to the origin: docs/03 §2, FACT for Q3 (UrT may differ). Crouching and
 * sliding shrink the box from the top, so both states share HULL_MINS.
 *
 * Shared constants that are never written: copy into a scratch vector before adjusting one.
 */
export const HULL_MINS: Vec3 = vec3(-15, -15, -24);
export const HULL_STANDING_MAXS: Vec3 = vec3(15, 15, 32);
export const HULL_CROUCHED_MAXS: Vec3 = vec3(15, 15, 16);

/** Eye height above the origin: docs/03 §2, FACT for Q3 (eye 50 u above the feet standing). */
export const VIEW_HEIGHT_STANDING = 26;
/** Eye height above the origin when crouched: docs/03 §2, FACT for Q3 (36 u above the feet). */
export const VIEW_HEIGHT_CROUCHED = 12;

/**
 * Water-level sample heights above the feet (origin z + HULL_MINS z), M2 design D-024. The
 * third sample is the eye (origin z + VIEW_HEIGHT_*). Design constants, not ESTIMATEs: 1 u puts
 * the feet sample just above a floor the player rests ε above, and 28 u is the middle of the
 * standing hull.
 */
export const WATER_SAMPLE_FEET = 1;
export const WATER_SAMPLE_WAIST = 28;
